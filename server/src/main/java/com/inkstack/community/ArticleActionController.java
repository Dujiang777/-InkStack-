package com.inkstack.community;

import com.inkstack.common.NodeShapes;
import com.inkstack.community.CommunityService.Liked;
import com.inkstack.mapper.CommunityMapper;
import com.inkstack.notify.Notifier;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.ClientMeta;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 文章页的四个写动作：点赞、收藏、举报、付费墙到达埋点。
 *
 * <p>前三个是登录限定的用户行为，最后一个是匿名可用的统计——漏斗需要游客数据，
 * 所以它不查身份，只按 IP 做窗口去重。
 */
@RestController
public class ArticleActionController {

  private final CommunityService community;
  private final ReportService reports;
  private final CommunityMapper db;
  private final Notifier notifier;
  private final PaywallDedup dedup;
  private final boolean trustProxy;

  public ArticleActionController(
      CommunityService community, ReportService reports, CommunityMapper db, Notifier notifier,
      PaywallDedup dedup, @Value("${inkstack.trust-proxy:0}") String trustProxy) {
    this.community = community;
    this.reports = reports;
    this.db = db;
    this.notifier = notifier;
    this.dedup = dedup;
    this.trustProxy = "1".equals(trustProxy);
  }

  /** 点赞是 toggle：同一人连点两次 = 点赞再取消，计数用 GREATEST 兜住不会成负。 */
  @PostMapping("/api/articles/{slug}/like")
  public ResponseEntity<Map<String, Object>> like(
      @Current SessionUser me, @PathVariable String slug) {
    if (me == null) {
      return err(401, "登录后才能点赞");
    }
    Liked r = community.toggleLike(slug, me);
    if (r == null) {
      return err(404, "文章不存在");
    }
    if (r.liked() && r.authorId() != me.id()) {
      notifier.send(r.authorId(), "like", "「" + r.title() + "」收到了一个赞",
          me.nickname() + " 赞了你的文章", "/article/" + slug);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("liked", r.liked());
    out.put("likeCount", r.likeCount());
    return ResponseEntity.ok(out);
  }

  @PostMapping("/api/articles/{slug}/bookmark")
  public ResponseEntity<Map<String, Object>> bookmark(
      @Current SessionUser me, @PathVariable String slug) {
    if (me == null) {
      return err(401, "登录后才能收藏");
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("bookmarked", community.toggleBookmark(me.id(), slug));
    return ResponseEntity.ok(out);
  }

  @PostMapping("/api/articles/{slug}/report")
  public ResponseEntity<Map<String, Object>> report(
      @Current SessionUser me, @PathVariable String slug, HttpServletRequest request) {
    if (me == null) {
      return err(401, "登录后才能举报");
    }
    String reason = NodeShapes.slice(
        NodeShapes.jsTrim(Bodies.text(Bodies.json(request), "reason")), 255);
    if (reason.length() < 2) {
      return err(400, "请填写举报原因（至少 2 字）");
    }
    switch (reports.submitArticle(me.id(), slug, reason)) {
      case OK -> {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("message", "举报已提交，运营会尽快核查");
        return ResponseEntity.ok(out);
      }
      case NOT_FOUND -> {
        return err(404, "文章不存在");
      }
      case DUPLICATE -> {
        return err(409, "该文章已有你提交的举报待处理，请耐心等待");
      }
      default -> {
        return err(500, "举报失败，请稍后再试");
      }
    }
  }

  /**
   * 付费墙到达：只在读者真被挡住时由前端组件挂载触发。
   * slug 超长直接拒，防的是把随机长串打进来占去一个去重槽位。
   */
  @PostMapping("/api/articles/{slug}/paywall-view")
  public ResponseEntity<Map<String, Object>> paywallView(
      @PathVariable String slug, HttpServletRequest request) {
    if (slug.length() > 200) {
      return ResponseEntity.status(400).body(Map.of("ok", false));
    }
    if (!dedup.firstHit(ClientMeta.from(request, trustProxy).ip(), slug)) {
      Map<String, Object> deduped = new LinkedHashMap<>();
      deduped.put("ok", true);
      deduped.put("deduped", true);
      return ResponseEntity.ok(deduped);
    }
    db.bumpPaywallView(slug);
    return ResponseEntity.ok(Map.of("ok", true));
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }
}
