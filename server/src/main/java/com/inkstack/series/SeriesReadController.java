package com.inkstack.series;

import com.inkstack.common.NodeShapes;
import com.inkstack.session.SessionService;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 书房与合集架的读侧。三条 URL 各自的方法与返回体都是**双轨契约**，改任何一条都要同步改 Node。
 *
 * <p>{@code GET /api/series} 是公开合集架，{@code GET /api/series/mine} 才是"我的专栏"。
 * 这两条原本挤在同一个 URL 上（Node 的 {@code GET /api/series} 是"我的专栏"），
 * 而切流只有前缀粒度，于是整个 {@code /api/series} 被那一处歧义钉住切不过去。
 *
 * <p>查询参数按 JS 的取值语义解析，而不是 Spring 的：{@code limit=abc} 在 Node 那边是
 * {@code Number("abc") || 60} → 60，若这里用带类型的 {@code int} 参数就会回 400 + 一段
 * 带时间戳的默认错误体——对拍比的正是字节，"两边都算错"也得错得一模一样。
 */
@RestController
@RequestMapping("/api/series")
public class SeriesReadController {

  private final SeriesService series;
  private final SessionService sessionService;

  public SeriesReadController(SeriesService series, SessionService sessionService) {
    this.series = series;
    this.sessionService = sessionService;
  }

  /** 我的专栏：登录才有"我的"，未登录是 401 而不是空列表（与 Node 的读法同一条契约）。 */
  @GetMapping("/mine")
  public ResponseEntity<Map<String, Object>> mine(jakarta.servlet.http.HttpServletRequest request) {
    Long viewerId = sessionService.resolve(request).map(s -> s.id()).orElse(null);
    if (viewerId == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("series", series.mine(viewerId));
    return ResponseEntity.ok(body);
  }

  /** 合集架：不带 author 即全站，带 author 即某作者（作者主页用 6，/series 页用默认 60）。 */
  @GetMapping
  public Map<String, Object> list(
      @RequestParam(name = "limit", required = false) String limit,
      @RequestParam(name = "author", required = false) String author) {
    return Map.of("series", series.cards(authorParam(author), limitParam(limit)));
  }

  /**
   * 落地页。专栏不存在回 {@code {"detail": null}}，与 Node getSeriesDetail 的 null 同语义；
   * id 不是整数（{@code /api/series/abc}）也走同一条空态而不是 400——读侧没有要报给浏览器的
   * 错误，两侧都按"没有这篇"渲染。写侧 PATCH/DELETE 的 404 是归属判定，另一回事。
   */
  @GetMapping("/{id}")
  public Map<String, Object> detail(@PathVariable String id,
      jakarta.servlet.http.HttpServletRequest request) {
    Long viewerId = sessionService.resolve(request).map(s -> s.id()).orElse(null);
    double parsed = NodeShapes.jsNumber(id);
    boolean integral = !Double.isNaN(parsed) && Double.isFinite(parsed) && parsed == Math.floor(parsed);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("detail", integral ? series.detail((long) parsed, viewerId) : null);
    return body;
  }

  /**
   * {@code limit}：Node 侧是 {@code Math.max(1, Math.min(200, Math.floor(Number(raw) || 60)))}。
   * 缺省、空串、非数字都回 60（JS 的 {@code Number(null)=0} 再被 {@code ||} 判成假），
   * {@code Infinity} 会被夹到 200 而不是当成缺省——这些分支都得与 Node 同式，否则对拍红。
   */
  private static int limitParam(String raw) {
    double d = NodeShapes.jsNumber(raw);
    if (Double.isNaN(d) || d == 0) {
      d = 60;
    }
    return Math.max(1, Math.min(200, (int) Math.floor(d)));
  }

  /**
   * {@code author}：Node 侧是 {@code Number.isInteger(n) && n !== 0} 才带上，否则走"全站"分支。
   * 所以非整数、非数字、0、没传都是全站；负数会被原样带进 SQL（结果为空，不是忽略）。
   */
  private static Long authorParam(String raw) {
    double d = NodeShapes.jsNumber(raw);
    if (Double.isNaN(d) || !Double.isFinite(d) || d == 0 || d != Math.floor(d)) {
      return null;
    }
    return (long) d;
  }
}
