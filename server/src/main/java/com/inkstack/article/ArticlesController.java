package com.inkstack.article;

import com.inkstack.mapper.ArticleMapper;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** GET /api/articles —— 与 Node 侧同形状，供首页与对拍脚本消费。 */
@RestController
@RequestMapping("/api/articles")
public class ArticlesController {

  private final ArticleMapper articles;

  public ArticlesController(ArticleMapper articles) {
    this.articles = articles;
  }

  @GetMapping
  public Map<String, Object> list() {
    List<ArticleView> views = articles.listFeed().stream().map(ArticleView::from).toList();
    return Map.of("articles", views);
  }
}
