package com.inkstack.series;

import com.inkstack.session.SessionService;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 书房：作者自己的专栏与柜中篇目（含未发布），未登录返回空列表。 */
@RestController
@RequestMapping("/api/series")
public class SeriesReadController {

  private final SeriesService series;
  private final SessionService sessionService;

  public SeriesReadController(SeriesService series, SessionService sessionService) {
    this.series = series;
    this.sessionService = sessionService;
  }

  @GetMapping("/mine")
  public Map<String, List<MySeriesView>> mine(jakarta.servlet.http.HttpServletRequest request) {
    return Map.of("series", sessionService.resolve(request)
        .map(viewer -> series.mine(viewer.id()))
        .orElseGet(List::of));
  }

  /** 合集架：不带 author 即全站，带 author 即某作者（作者主页用 6，/series 页用默认 60）。 */
  @GetMapping
  public Map<String, Object> list(
      @RequestParam(name = "limit", defaultValue = "60") int limit,
      @RequestParam(name = "author", required = false) Long author) {
    return Map.of("series", series.cards(author, Math.max(1, Math.min(limit, 200))));
  }

  /** 落地页。专栏不存在回 {@code {"detail": null}}，与 Node getSeriesDetail 的 null 同语义。 */
  @GetMapping("/{id}")
  public Map<String, Object> detail(@PathVariable long id,
      jakarta.servlet.http.HttpServletRequest request) {
    Long viewerId = sessionService.resolve(request).map(s -> s.id()).orElse(null);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("detail", series.detail(id, viewerId));
    return body;
  }
}
