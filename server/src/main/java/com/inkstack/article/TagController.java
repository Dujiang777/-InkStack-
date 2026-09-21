package com.inkstack.article;

import com.inkstack.mapper.ArticleMapper;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 话题页列表：GET /api/tags/{tag}/articles。
 *
 * <p>标签是 JSON 数组里的一个字符串元素，所以匹配走 JSON_CONTAINS，参数得先包成
 * 合法的 JSON 标量字面量（外加引号、转义反斜杠与引号）。这一步在 Java 里做而不在 SQL 里做，
 * 是为了继续用占位符绑定——标签来自 URL，绝不能进 SQL 文本。
 */
@RestController
public class TagController {

  private final ArticleMapper articles;

  public TagController(ArticleMapper articles) {
    this.articles = articles;
  }

  static String asJsonScalar(String tag) {
    return "\"" + tag.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  @GetMapping("/api/tags/{tag}/articles")
  public Map<String, List<TagArticleView>> list(@PathVariable String tag,
      @RequestParam(name = "limit", defaultValue = "50") int limit) {
    return Map.of("articles", articles.listByTag(asJsonScalar(tag), Math.max(1, Math.min(limit, 200)))
        .stream().map(TagArticleView::from).toList());
  }
}
