package com.inkstack.article;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.NodeShapes;
import com.inkstack.common.Pricing;
import com.inkstack.entity.ArticleWriteRows;
import com.inkstack.notify.Notifier;
import com.inkstack.points.PointsService;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 创作台的三条写接口：发布、编辑（含存草稿与草稿转正）、撤回。
 *
 * <p>审核流是这里唯一"看起来像可选参数、其实是权限"的东西：普通用户的每次发布与编辑都落
 * {@code review_status='pending'}，管理员直接 {@code approved}。判定只认签名 Cookie 里的 role，
 * 不接受请求体里传 reviewStatus。
 */
@RestController
public class ArticleWriteController {

  private static final long PUBLISH_REWARD = 20L;
  private static final long PUBLISH_CAP = 1L;

  private final ArticleWriteService write;
  private final PointsService points;
  private final Notifier notifier;

  public ArticleWriteController(ArticleWriteService write, PointsService points, Notifier notifier) {
    this.write = write;
    this.points = points;
    this.notifier = notifier;
  }

  @PostMapping("/api/articles")
  public ResponseEntity<Map<String, Object>> publish(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return err(401, "登录后才能发布文章");
    }
    JsonNode body = Bodies.json(request);
    Draft draft = Draft.from(body, me);
    String bad = draft.validate();
    if (bad != null) {
      return err(400, bad);
    }
    boolean asDraft = isTrue(body, "draft");
    String slug;
    try {
      slug = write.insert(draft.row(), asDraft);
    } catch (RuntimeException failed) {
      return err(500, "发布失败（数据库异常）");
    }
    if (asDraft) {
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("ok", true);
      out.put("draft", true);
      out.put("slug", slug);
      return ResponseEntity.ok(out);
    }
    PointsService.Reward reward =
        points.grantCappedReward(me.id(), PUBLISH_REWARD, "发布奖励", "publish", PUBLISH_CAP);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("reviewPending", !staff(me));
    out.put("reward", reward.granted() ? PUBLISH_REWARD : 0L);
    out.put("capped", reward.capped());
    // balance 只在真发了墨时才有：Node 那边是 undefined，JSON 里根本不会出现这个键。
    if (reward.granted()) {
      out.put("balance", reward.balance());
    }
    return ResponseEntity.ok(out);
  }

  @PutMapping("/api/articles/{slug}")
  public ResponseEntity<Map<String, Object>> edit(
      @Current SessionUser me, @PathVariable String slug, HttpServletRequest request) {
    if (me == null) {
      return err(401, "请先登录");
    }
    JsonNode body = Bodies.json(request);
    Draft draft = Draft.from(body, me);
    boolean asDraft = isTrue(body, "draft");
    boolean asPublish = isTrue(body, "publish");
    // 一键发布：既没带标题也没带正文（此时不校验内容，正文保持草稿原样）
    boolean publishOnly = asPublish && draft.title().isEmpty() && draft.md().isEmpty();
    if (!publishOnly) {
      String bad = draft.validate();
      if (bad != null) {
        return err(400, bad);
      }
    }
    ArticleWriteRows.Head art;
    try {
      art = write.head(slug);
      if (art == null) {
        return err(404, "文章不存在");
      }
      if (art.getAuthorId() != me.id() && !staff(me)) {
        return err(403, "只能编辑自己的文章");
      }
      boolean wasDraft = "draft".equals(art.getStatus());
      if (asDraft) {
        // 已发布内容不允许"退回草稿"绕过审核
        if (!wasDraft) {
          return err(400, "已发布/审核中的文章不支持存草稿，请走重新提审");
        }
        write.saveDraft(draft.row(), art.getId());
        return ResponseEntity.ok(Map.of("ok", true, "draft", true));
      }
      String reviewStatus = staff(me) ? "approved" : "pending";
      if (publishOnly) {
        write.publishOnly(reviewStatus, art.getId());
      } else {
        write.updateAndPublish(draft.row(), reviewStatus, wasDraft, art.getId());
      }
      long reward = 0L;
      boolean capped = false;
      if (wasDraft) {
        PointsService.Reward r =
            points.grantCappedReward(me.id(), PUBLISH_REWARD, "发布奖励", "publish", PUBLISH_CAP);
        reward = r.granted() ? PUBLISH_REWARD : 0L;
        capped = r.capped();
      }
      if ("pending".equals(reviewStatus)) {
        notifyAdmins(draft.title(), wasDraft, me.nickname());
      }
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("ok", true);
      out.put("reviewStatus", reviewStatus);
      out.put("reward", reward);
      out.put("capped", capped);
      out.put("publishedFromDraft", wasDraft);
      return ResponseEntity.ok(out);
    } catch (RuntimeException failed) {
      return err(500, "保存失败（数据库异常）");
    }
  }

  @DeleteMapping("/api/articles/{slug}")
  public ResponseEntity<Map<String, Object>> withdraw(
      @Current SessionUser me, @PathVariable String slug) {
    if (me == null) {
      return err(401, "请先登录");
    }
    try {
      ArticleWriteRows.Head art = write.head(slug);
      if (art == null) {
        return err(404, "文章不存在");
      }
      if (art.getAuthorId() != me.id() && !staff(me)) {
        return err(403, "只能撤回自己的文章");
      }
      boolean deleted = write.withdraw(art.getId(), art.getStatus());
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("ok", true);
      if (deleted) {
        out.put("deleted", true);
      }
      return ResponseEntity.ok(out);
    } catch (RuntimeException failed) {
      return err(500, "撤回失败（数据库异常）");
    }
  }

  /** 重新提审要通知每一位运营；单个通知失败由 Notifier 自己吞掉。 */
  private void notifyAdmins(String title, boolean wasDraft, String nickname) {
    for (Long admin : write.admins()) {
      notifier.send(admin, "review", "《" + title + "》" + (wasDraft ? "发布" : "更新") + "，等待审核",
          nickname + " 提交了文章", "/admin");
    }
  }

  private static boolean staff(SessionUser me) {
    return me.isStaff();
  }

  /** {@code body.x === true}：只认 JSON 布尔真，"true"/1 都不算（与 Node 的严格比较同）。 */
  private static boolean isTrue(JsonNode body, String field) {
    JsonNode value = body.get(field);
    return value != null && value.isBoolean() && value.booleanValue();
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }

  /** 表单裁剪结果；{@code validate()} 返回第一条要报给用户的文案，null 表示通过。 */
  private record Draft(String title, String md, ArticleWriteRows.Row row) {

    static Draft from(JsonNode body, SessionUser me) {
      String title = NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(body, "title")), 200);
      String md = NodeShapes.jsTrim(Bodies.text(body, "md"));
      String summaryBody = NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(body, "summary")), 500);
      String cover = NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(body, "coverLabel")), 32);
      double rawPrice = Bodies.number(body, "unlockPrice");
      long price = clampPrice(rawPrice);
      Pricing.Discount discount =
          Pricing.parseDiscount(Bodies.number(body, "discountPrice"), Bodies.text(body, "discountUntil"), price);
      ArticleWriteRows.Row row = new ArticleWriteRows.Row();
      row.setAuthorId(me == null ? null : me.id());
      row.setTitle(title);
      row.setMd(md);
      row.setSummary(summaryBody.isEmpty() ? null : summaryBody);
      row.setCoverLabel(cover.isEmpty() ? "新稿" : cover);
      row.setTags(Bodies.tagArray(body, "tags", 6, 20, "创作"));
      row.setUnlockPrice(price);
      row.setDiscountPrice(discount.price());
      row.setDiscountUntil(discount.until());
      row.setReviewStatus(me != null && me.isStaff() ? "approved" : "pending");
      return new Draft(title, md, row);
    }

    /** 与 Node 同序：先标题、再正文长度、最后上限。 */
    String validate() {
      if (title.isEmpty()) {
        return "标题不能为空";
      }
      if (md.length() < 10) {
        return "正文太短（至少 10 字）";
      }
      if (md.length() > 100_000) {
        return "正文过长（上限 10 万字）";
      }
      return null;
    }

    /** {@code Math.max(0, Math.min(10000, Math.floor(Number(x) || 0)))}：NaN 与负数都落 0。 */
    static long clampPrice(double raw) {
      double n = Double.isNaN(raw) ? 0d : raw;
      return Math.max(0L, Math.min(10_000L, (long) Math.floor(n)));
    }
  }
}
