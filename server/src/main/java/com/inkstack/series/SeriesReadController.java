package com.inkstack.series;

import com.inkstack.session.SessionService;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
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
}
