package com.inkstack.user;

import com.inkstack.article.AuthorArticleView;
import com.inkstack.common.NodeShapes;
import com.inkstack.entity.AuthorProfile;
import com.inkstack.mapper.ArticleMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 作者主页的公开档案与文章列表。档案不存在时回 {@code {"author": null}}（不是 404）——
 * Node 侧 getAuthor 返回 null，页面据此 notFound()；用 null 才能让分流后的分支保持一致。
 */
@RestController
@RequestMapping("/api/authors/{id}")
public class AuthorController {

  private final AuthorMapper authors;
  private final ArticleMapper articles;

  public AuthorController(AuthorMapper authors, ArticleMapper articles) {
    this.authors = authors;
    this.articles = articles;
  }

  @GetMapping
  public Map<String, Object> profile(@PathVariable long id) {
    AuthorProfile row = authors.profile(id);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("author", row == null ? null : view(row));
    return body;
  }

  @GetMapping("/articles")
  public Map<String, Object> list(@PathVariable long id,
      @RequestParam(name = "limit", defaultValue = "30") int limit) {
    return Map.of("articles", articles.listByAuthor(id, Math.max(1, Math.min(limit, 100))).stream()
        .map(AuthorArticleView::from).toList());
  }

  private static Map<String, Object> view(AuthorProfile r) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("id", r.getId());
    body.put("nickname", r.getNickname());
    body.put("avatarText", r.getAvatarText() == null ? "墨" : r.getAvatarText());
    body.put("avatarTone", NodeShapes.text(r.getAvatarTone()));
    body.put("avatarShape", NodeShapes.text(r.getAvatarShape()));
    body.put("bio", NodeShapes.text(r.getBio()));
    body.put("createdAt", NodeShapes.text(r.getCreatedAt()));
    body.put("articles", NodeShapes.num(r.getArticles()));
    body.put("likes", NodeShapes.num(r.getLikes()));
    body.put("readTotal", NodeShapes.num(r.getReadTotal()));
    return body;
  }
}
