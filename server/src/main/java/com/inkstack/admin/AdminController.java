package com.inkstack.admin;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.admin.AdminService.Removed;
import com.inkstack.admin.AdminService.Result;
import com.inkstack.admin.AdminService.Review;
import com.inkstack.common.NodeShapes;
import com.inkstack.notify.Notifier;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 运营台的四条写接口（内容 / 评论 / 举报 / 用户）。
 *
 * <p>门禁在方法第一件事：登录 + {@code isStaff}。角色的进一步区分（只有 developer 能改角色）
 * 也必须在服务端判——前端的下拉隐藏不是防线。
 */
@RestController
public class AdminController {

  private static final List<String> ACTIONS =
      List.of("publish", "unpublish", "pin", "unpin", "feature", "unfeature");
  private static final List<String> REVIEW = List.of("approve", "reject");
  private static final List<String> HANDLES = List.of("delete_content", "keep", "dismiss");
  private static final List<String> USER_ACTIONS = List.of("ban", "unban", "grant", "revoke", "setRole");

  private final AdminService admin;
  private final AdminQueryService queries;
  private final Notifier notifier;

  public AdminController(AdminService admin, AdminQueryService queries, Notifier notifier) {
    this.admin = admin;
    this.queries = queries;
    this.notifier = notifier;
  }

  /* ==================== 运营台读侧（P7f-1e） ====================
   *
   * 这八条 GET 是运营台页面原本在 Next 进程里直连 MySQL 的那八条读的新家。它们和上面四条写
   * 共用<b>同一个</b> staffOnly 门禁——读侧漏出来的东西比写侧更敏感（用户管理那张表带邮箱），
   * 所以"只有四条写接口需要门禁"这种旧印象必须在这里堵住：门禁写在方法第一件事，一条不落。
   *
   * Node 侧从来没有这些 URL（Server Component 直调 lib/data.ts，压根不经过 HTTP），
   * 因此没有对岸可对拍：形状与取数的正确性由闸门 19 回库复算钉住。
   */

  @GetMapping("/api/admin/articles")
  public ResponseEntity<Map<String, Object>> articlesRead(@Current SessionUser me) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(Map.of("articles", queries.articles()));
  }

  @GetMapping("/api/admin/review")
  public ResponseEntity<Map<String, Object>> reviewRead(@Current SessionUser me) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(Map.of("review", queries.reviewQueue()));
  }

  @GetMapping("/api/admin/users")
  public ResponseEntity<Map<String, Object>> usersRead(
      @Current SessionUser me, @RequestParam(name = "q", required = false) String q) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(Map.of("users", queries.users(q)));
  }

  @GetMapping("/api/admin/reports")
  public ResponseEntity<Map<String, Object>> reportsRead(
      @Current SessionUser me, @RequestParam(name = "status", required = false) String status) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(Map.of("reports", queries.reports(status)));
  }

  @GetMapping("/api/admin/actions")
  public ResponseEntity<Map<String, Object>> actionsRead(
      @Current SessionUser me, @RequestParam(name = "limit", required = false) String limit) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(Map.of("actions", queries.actions(limit)));
  }

  @GetMapping("/api/admin/orders")
  public ResponseEntity<Map<String, Object>> ordersRead(@Current SessionUser me) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(Map.of("orders", queries.orders()));
  }

  @GetMapping("/api/admin/comments")
  public ResponseEntity<Map<String, Object>> commentsRead(@Current SessionUser me) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(Map.of("comments", queries.comments()));
  }

  /** 顶部 9 个计数 + 最近问答：同样过 staffOnly，游客连"有多少人注册"都不该问到。 */
  @GetMapping("/api/admin/overview")
  public ResponseEntity<Map<String, Object>> overviewRead(@Current SessionUser me) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(queries.overview());
  }

  /** 大盘：形状是对象而非列表，直接把 insights 那五个键平铺回去（页面吃的就是这个）。 */
  @GetMapping("/api/admin/insights")
  public ResponseEntity<Map<String, Object>> insightsRead(@Current SessionUser me) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    return gate != null ? gate : ResponseEntity.ok(queries.insights());
  }

  @PostMapping("/api/admin/articles")
  public ResponseEntity<Map<String, Object>> articles(
      @Current SessionUser me, HttpServletRequest request) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    if (gate != null) {
      return gate;
    }
    JsonNode body = Bodies.json(request);
    String slug = NodeShapes.jsTrim(Bodies.text(body, "slug"));
    String action = Bodies.text(body, "action");
    if (slug.isEmpty()) {
      return err(400, "参数须为 { slug, action, note? }");
    }
    if (REVIEW.contains(action)) {
      boolean approve = "approve".equals(action);
      String note = nullableText(body.get("note"));
      Review r = admin.review(slug, approve, note);
      if (!r.ok()) {
        return err(400, r.error());
      }
      admin.log(me.id(), "review:" + (approve ? "approve" : "reject"), "article", slug,
          approve ? "审核通过" : note);
      if (r.authorId() != 0) {
        if (approve) {
          notifier.send(r.authorId(), "review", "你的文章已通过审核", "《" + slug + "》现已公开可见",
              "/article/" + slug);
        } else {
          String reason = NodeShapes.jsTrim(NodeShapes.text(note));
          notifier.send(r.authorId(), "review", "文章未通过审核",
              "原因：" + (reason.isEmpty() ? "内容不符合社区规范" : reason) + "。可在书房修改后重新提交。",
              "/study");
        }
      }
      return done(slug, action);
    }
    if ("price".equals(action)) {
      Result r = admin.setPrice(slug,
          Bodies.number(body, "unlockPrice"), Bodies.number(body, "discountPrice"));
      if (!r.ok()) {
        return err(400, r.error());
      }
      admin.log(me.id(), "article:price", "article", slug,
          "解锁 " + orZero(body.get("unlockPrice")) + " / 折扣 " + orZero(body.get("discountPrice")));
      return done(slug, action);
    }
    if (!ACTIONS.contains(action)) {
      return err(400, "action ∈ publish|unpublish|pin|unpin|feature|unfeature|approve|reject");
    }
    Result r = admin.setArticle(slug, action);
    if (!r.ok()) {
      return err(400, r.error());
    }
    admin.log(me.id(), "article:" + action, "article", slug, null);
    return done(slug, action);
  }

  @PostMapping("/api/admin/comments")
  public ResponseEntity<Map<String, Object>> comments(
      @Current SessionUser me, HttpServletRequest request) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    if (gate != null) {
      return gate;
    }
    JsonNode body = Bodies.json(request);
    long commentId = (long) Bodies.number(body, "commentId");
    if (commentId <= 0 || !"delete".equals(Bodies.text(body, "action"))) {
      return err(400, "参数须为 { commentId, action: 'delete' }");
    }
    Removed r = admin.deleteComment(commentId);
    if (!r.ok()) {
      return err(400, r.error());
    }
    admin.log(me.id(), "comment:delete", "comment", commentId,
        "删除 " + (r.removed() == null ? 1 : r.removed()) + " 条");
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("removed", r.removed());
    return ResponseEntity.ok(out);
  }

  @PostMapping("/api/admin/reports")
  public ResponseEntity<Map<String, Object>> reports(
      @Current SessionUser me, HttpServletRequest request) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    if (gate != null) {
      return gate;
    }
    JsonNode body = Bodies.json(request);
    long reportId = (long) Bodies.number(body, "reportId");
    String handle = Bodies.text(body, "handle");
    if (reportId <= 0 || !HANDLES.contains(handle)) {
      return err(400, "参数须为 { reportId, handle: delete_content|keep|dismiss, note? }");
    }
    String note = nullableText(body.get("note"));
    Result r = admin.handleReport(reportId, handle, note);
    if (!r.ok()) {
      return err(400, r.error());
    }
    admin.log(me.id(), "report:" + handle, "report", reportId, note);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("reportId", reportId);
    out.put("handle", handle);
    return ResponseEntity.ok(out);
  }

  @PostMapping("/api/admin/users")
  public ResponseEntity<Map<String, Object>> users(
      @Current SessionUser me, HttpServletRequest request) {
    ResponseEntity<Map<String, Object>> gate = staffOnly(me);
    if (gate != null) {
      return gate;
    }
    JsonNode body = Bodies.json(request);
    double rawUserId = Bodies.number(body, "userId");
    String action = Bodies.text(body, "action");
    if (!(rawUserId > 0) || !USER_ACTIONS.contains(action)) {
      return err(400, "参数须为 { userId, action: ban|unban|grant|revoke|setRole, amount?, role? }");
    }
    if ("setRole".equals(action) && !"developer".equals(me.role())) {
      return err(403, "仅开发者可变更用户角色");
    }
    long userId = (long) rawUserId;
    Result r = admin.setUser(userId, action, Bodies.number(body, "amount"), Bodies.text(body, "role"));
    if (!r.ok()) {
      return err(400, r.error());
    }
    String amountRaw = orZero(body.get("amount"));
    String roleRaw = orZero(body.get("role"));
    String label = switch (action) {
      case "ban" -> "封禁账号";
      case "unban" -> "解除封禁";
      case "grant" -> "发放 " + amountRaw + " 点墨";
      case "revoke" -> "扣回 " + amountRaw + " 点墨";
      default -> "角色变更为 " + roleRaw;
    };
    admin.log(me.id(), "user:" + action, "user", userId, label);
    notifyUser(me, userId, action, roleRaw, label);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("userId", userId);
    out.put("action", action);
    return ResponseEntity.ok(out);
  }

  private void notifyUser(
      SessionUser me, long userId, String action, String roleRaw, String label) {
    if ("setRole".equals(action)) {
      notifier.send(userId, "system", "你的账号角色已调整",
          "运营台已将你的角色调整为「" + roleLabel(roleRaw) + "」", "/me");
      return;
    }
    String title = switch (action) {
      case "ban" -> "你的账号已被封禁";
      case "unban" -> "账号封禁已解除";
      default -> "墨仓变动：" + label;
    };
    String body = switch (action) {
      case "ban" -> "如有疑问请联系平台邮箱申诉";
      case "unban" -> "欢迎回来，继续创作吧";
      default -> "由平台运营操作，可在墨仓流水中核对";
    };
    String link = "grant".equals(action) || "revoke".equals(action) ? "/points" : null;
    notifier.send(userId, "system", title, body, link);
  }

  private static String roleLabel(String role) {
    return switch (role) {
      case "reader" -> "读者";
      case "author" -> "作者";
      case "admin" -> "管理员";
      default -> role;
    };
  }

  /** 未登录 401、非运营 403：四条接口同一套门禁，文案也同一套。 */
  private static ResponseEntity<Map<String, Object>> staffOnly(SessionUser me) {
    if (me == null) {
      return err(401, "请先登录");
    }
    if (!me.isStaff()) {
      return err(403, "仅管理团队可操作");
    }
    return null;
  }

  /**
   * JSON 里"没有这个键 / 显式 null"与"空串"是两件事：Node 用的是 {@code ??}，
   * 只有前者才落到默认值。所以这里必须能区分 null 与 ""。
   */
  private static String nullableText(JsonNode value) {
    if (value == null || value.isNull() || value.isMissingNode()) {
      return null;
    }
    return Bodies.stringOf(value);
  }

  /** {@code body.x ?? 0} 的字符串形态：审计日志里写的是客户端原样的值。 */
  private static String orZero(JsonNode value) {
    if (value == null || value.isNull() || value.isMissingNode()) {
      return "0";
    }
    return Bodies.stringOf(value);
  }

  private static ResponseEntity<Map<String, Object>> done(String slug, String action) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("slug", slug);
    out.put("action", action);
    return ResponseEntity.ok(out);
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }
}
