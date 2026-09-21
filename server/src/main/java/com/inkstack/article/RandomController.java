package com.inkstack.article;

import com.inkstack.mapper.ArticleMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 漫游记：GET /api/random?exclude=slug → {"slug": "..."} 或 {"slug": null}。
 *
 * <p>独立路径而不是挂在 /api/articles 下，是为了不占用 "{slug}" 这个模板——
 * 否则真有一篇 slug 叫 random 的文章时，两条路由会互相遮蔽。
 */
@RestController
public class RandomController {

  private final ArticleMapper articles;

  public RandomController(ArticleMapper articles) {
    this.articles = articles;
  }

  @GetMapping("/api/random")
  public Map<String, Object> random(@RequestParam(name = "exclude", defaultValue = "") String exclude) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("slug", articles.randomSlug(exclude == null ? "" : exclude.trim()));
    return body;
  }
}
