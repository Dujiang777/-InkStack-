package com.inkstack.article;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.ArticleDetail;
import com.inkstack.mapper.ArticleMapper;
import com.inkstack.session.SessionService;
import com.inkstack.session.SessionUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** /api/articles 读接口：列表与详情。写接口仍在 Node 侧（P4/P5 迁）。 */
@RestController
@RequestMapping("/api/articles")
public class ArticlesController {

  private final ArticleMapper articles;
  private final SessionService sessionService;

  public ArticlesController(ArticleMapper articles, SessionService sessionService) {
    this.articles = articles;
    this.sessionService = sessionService;
  }

  @GetMapping
  public Map<String, Object> list() {
    List<ArticleView> views = articles.listFeed().stream().map(ArticleView::from).toList();
    return Map.of("articles", views);
  }

  /**
   * 详情。付费墙判定完全在服务端完成：先按"最多 6 行"取，只有作者/运营/已购才二次取全文。
   * 顺序不能反——先取全文再判断就等于把防线拆了。
   */
  @GetMapping("/{slug}")
  public ResponseEntity<?> detail(@PathVariable String slug, HttpServletRequest request) {
    SessionUser viewer = sessionService.resolve(request).orElse(null);
    boolean privileged = viewer != null && viewer.isStaff();
    Long viewerId = viewer == null ? null : viewer.id();

    ArticleDetail row = articles.findDetail(slug, viewerId, privileged, false);
    if (row == null) {
      return ResponseEntity.status(404).body(Map.of("error", "文章不存在"));
    }
    boolean locked = NodeShapes.num(row.getUnlockPrice()) > 0
        && !NodeShapes.flag(row.getViewerUnlocked());
    String md = row.getMd();
    if (!locked) {
      ArticleDetail full = articles.findDetail(slug, viewerId, privileged, true);
      if (full != null) {
        md = full.getMd();
      }
    }
    return ResponseEntity.ok(Map.of("article", ArticleDetailView.from(row, md)));
  }
}
