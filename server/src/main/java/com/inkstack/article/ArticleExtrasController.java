package com.inkstack.article;

import com.inkstack.comment.CommentView;
import com.inkstack.entity.TipRow;
import com.inkstack.mapper.CommentMapper;
import com.inkstack.mapper.SocialMapper;
import com.inkstack.series.SeriesService;
import com.inkstack.session.SessionService;
import com.inkstack.session.SessionUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 文章页的读侧附加数据：评论区、打赏动态、收藏态、专栏上下篇。 */
@RestController
@RequestMapping("/api/articles/{slug}")
public class ArticleExtrasController {

  private final CommentMapper comments;
  private final SocialMapper social;
  private final SeriesService series;
  private final SessionService sessionService;

  public ArticleExtrasController(
      CommentMapper comments, SocialMapper social, SeriesService series, SessionService sessionService) {
    this.comments = comments;
    this.social = social;
    this.series = series;
    this.sessionService = sessionService;
  }

  @GetMapping("/comments")
  public Map<String, Object> comments(@PathVariable String slug, HttpServletRequest request) {
    Long viewerId = sessionService.resolve(request).map(SessionUser::id).orElse(null);
    List<CommentView> rows = comments.listByArticleSlug(slug, viewerId).stream()
        .map(CommentView::from).toList();
    return Map.of("comments", rows);
  }

  @GetMapping("/tips")
  public Map<String, Object> tips(@PathVariable String slug,
      @RequestParam(name = "limit", defaultValue = "6") int limit) {
    List<TipRow> rows = social.listArticleTips(slug, Math.max(1, Math.min(limit, 50)));
    return Map.of("tips", rows);
  }

  @GetMapping("/saved")
  public Map<String, Object> saved(@PathVariable String slug, HttpServletRequest request) {
    boolean saved = sessionService.resolve(request)
        .map(v -> social.existsBookmark(v.id(), slug) != null)
        .orElse(false);
    return Map.of("saved", saved);
  }

  /** 不在任何公开专栏里时返回 {"nav":null}，与 Node 的 null 同语义（Map.of 不允许 null 值）。 */
  @GetMapping("/series-nav")
  public Map<String, Object> seriesNav(@PathVariable String slug) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("nav", series.navFor(slug));
    return body;
  }
}
