package com.inkstack.user;

import com.inkstack.entity.FollowCounts;
import com.inkstack.mapper.ArticleMapper;
import com.inkstack.mapper.SocialMapper;
import com.inkstack.session.SessionService;
import com.inkstack.session.SessionUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 个人中心 / 创作台的"我"字头读接口，一律按会话里的 uid 圈定，不接受外部传 userId——
 * 这些列表含未过审内容，越权面比公开列表大，身份只能来自签名 Cookie。
 *
 * <p>{@code /api/me/overview} 与 Node 同名路由同形状（含 401 的"请先登录"），
 * 因此它既能被 RSC 数据源分流复用，也能直接进 JAVA_ROUTES 切流。
 */
@RestController
@RequestMapping("/api/me")
public class MeReadController {

  private static final ResponseEntity<Map<String, Object>> ANONYMOUS =
      ResponseEntity.status(401).body(Map.of("error", "请先登录"));

  private final SocialMapper social;
  private final ArticleMapper articles;
  private final SessionService sessionService;

  public MeReadController(SocialMapper social, ArticleMapper articles, SessionService sessionService) {
    this.social = social;
    this.articles = articles;
    this.sessionService = sessionService;
  }

  private Long viewerId(HttpServletRequest request) {
    return sessionService.resolve(request).map(SessionUser::id).orElse(null);
  }

  private static int clamp(int raw, int max) {
    return Math.max(1, Math.min(raw, max));
  }

  @GetMapping("/following")
  public ResponseEntity<?> following(HttpServletRequest request,
      @RequestParam(name = "limit", defaultValue = "50") int limit) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("following", social.following(me, clamp(limit, 200)).stream()
        .map(MeViews.Peer::from).toList()));
  }

  @GetMapping("/followers")
  public ResponseEntity<?> followers(HttpServletRequest request,
      @RequestParam(name = "limit", defaultValue = "50") int limit) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("followers", social.followers(me, clamp(limit, 200)).stream()
        .map(MeViews.Peer::from).toList()));
  }

  @GetMapping("/likes")
  public ResponseEntity<?> likes(HttpServletRequest request,
      @RequestParam(name = "limit", defaultValue = "30") int limit) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("likes", social.myLikes(me, clamp(limit, 200)).stream()
        .map(MeViews.Like::from).toList()));
  }

  @GetMapping("/comments")
  public ResponseEntity<?> comments(HttpServletRequest request,
      @RequestParam(name = "limit", defaultValue = "30") int limit) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("comments", social.myComments(me, clamp(limit, 200)).stream()
        .map(MeViews.Comment::from).toList()));
  }

  @GetMapping("/bookmarks")
  public ResponseEntity<?> bookmarks(HttpServletRequest request,
      @RequestParam(name = "limit", defaultValue = "50") int limit) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("bookmarks", social.myBookmarks(me, clamp(limit, 200)).stream()
        .map(MeViews.Bookmark::from).toList()));
  }

  @GetMapping("/history")
  public ResponseEntity<?> history(HttpServletRequest request,
      @RequestParam(name = "limit", defaultValue = "30") int limit) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("history", social.myHistory(me, clamp(limit, 200)).stream()
        .map(MeViews.Read::from).toList()));
  }

  /** 书房：{rows, stats} 两键，与 Node listMyArticles 的返回结构一致。 */
  @GetMapping("/articles")
  public ResponseEntity<?> myArticles(HttpServletRequest request) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("rows", articles.myArticles(me).stream().map(MeViews.Article::from).toList());
    body.put("stats", MeViews.Stats.from(articles.myArticleStats(me)));
    return ResponseEntity.ok(body);
  }

  @GetMapping("/author-stats")
  public ResponseEntity<?> authorStats(HttpServletRequest request,
      @RequestParam(name = "limit", defaultValue = "50") int limit) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("stats", articles.authorArticleStats(me, clamp(limit, 200)).stream()
        .map(MeViews.Work::from).toList()));
  }

  @GetMapping("/funnel")
  public ResponseEntity<?> funnel(HttpServletRequest request) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("rows", articles.myFunnel(me).stream()
        .map(MeViews.Funnel::from).toList()));
  }

  @GetMapping("/unlock-income")
  public ResponseEntity<?> unlockIncome(HttpServletRequest request) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    return ResponseEntity.ok(Map.of("income", MeViews.UnlockIncome.of(articles.myUnlockIncome(me))));
  }

  /** Node 的 app/api/me/overview 只给这四样，这里不多不少——多一个键对拍就红。 */
  @GetMapping("/overview")
  public ResponseEntity<?> overview(HttpServletRequest request) {
    Long me = viewerId(request);
    if (me == null) {
      return ANONYMOUS;
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("following", social.following(me, 50).stream().map(MeViews.Peer::from).toList());
    body.put("likes", social.myLikes(me, 30).stream().map(MeViews.Like::from).toList());
    body.put("comments", social.myComments(me, 30).stream().map(MeViews.Comment::from).toList());
    body.put("stats", followStats(me));
    return ResponseEntity.ok(body);
  }

  private Map<String, Object> followStats(long me) {
    FollowCounts counts = social.followCounts(me);
    Map<String, Object> stats = new LinkedHashMap<>();
    stats.put("followers", counts == null || counts.getFollowers() == null ? 0L : counts.getFollowers());
    stats.put("following", counts == null || counts.getFollowing() == null ? 0L : counts.getFollowing());
    return stats;
  }
}
