package com.inkstack.article;

import com.inkstack.mapper.SearchMapper;
import com.inkstack.session.SessionService;
import com.inkstack.session.SessionUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/search?q= —— 与 Node 路由同形状：{@code {ok, keyword, count, results}}，
 * 关键词不足 2 字同样回 400 {@code {error}}。游客与已登录读者走同一条 SQL，
 * 差别只在 me 传 0 还是传真实 id（见 SearchMapper 的付费墙纵深说明）。
 */
@RestController
public class SearchController {

  private final SearchMapper search;
  private final SessionService sessionService;

  public SearchController(SearchMapper search, SessionService sessionService) {
    this.search = search;
    this.sessionService = sessionService;
  }

  /** 供 RSC 数据源分流复用的检索：入参是已经 trim 过的原文。 */
  public List<SearchView> query(String keyword, long viewerId, int limit) {
    String kw = keyword.trim();
    if (kw.length() > 60) {
      kw = kw.substring(0, 60);
    }
    if (kw.length() < 2) {
      return List.of();
    }
    // v17.0：转义 LIKE 通配符（% _ \），防关键词里的 % 变成全匹配
    String like = "%" + kw.replaceAll("[\\\\%_]", "\\\\$0") + "%";
    return search.search(kw, like, Math.max(viewerId, 0), limit).stream()
        .map(SearchView::from).toList();
  }

  @GetMapping("/api/search")
  public ResponseEntity<?> search(@RequestParam(name = "q", defaultValue = "") String q,
      @RequestParam(name = "limit", defaultValue = "20") int limit,
      HttpServletRequest request) {
    String keyword = q == null ? "" : q.trim();
    if (keyword.length() < 2) {
      return ResponseEntity.badRequest().body(Map.of("error", "关键词至少 2 个字"));
    }
    long me = sessionService.resolve(request).map(SessionUser::id).orElse(0L);
    List<SearchView> results = query(keyword, me, Math.max(1, Math.min(limit, 50)));
    return ResponseEntity.ok(Map.of("ok", true, "keyword", keyword, "count", results.size(),
        "results", results));
  }
}
