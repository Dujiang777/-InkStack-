package com.inkstack.weekly;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.WeeklyCounts;
import com.inkstack.mapper.StatsMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 每周墨报的本期计数：GET /api/weekly/stats?from=YYYY-MM-DD。
 *
 * <p>只搬计数，不搬周报的其余部分——期号、近 6 周分桶、本周热榜与最新刊都是对已经分流到
 * Java 的列表结果做纯 JS 组装（见 lib/data.ts listWeekly），在 Java 里重算一遍只会多出
 * 一套时区口径。"本期从哪天开始"这个决定权留在 Node，两栈才不会因为周界算法不同而差一天。
 */
@RestController
@RequestMapping("/api/weekly")
public class WeeklyController {

  private final StatsMapper stats;

  public WeeklyController(StatsMapper stats) {
    this.stats = stats;
  }

  @GetMapping("/stats")
  public Map<String, Object> stats(@RequestParam(name = "from") String from) {
    WeeklyCounts row = stats.weeklySince(from.trim());
    Map<String, Object> body = new LinkedHashMap<>();
    if (row == null) {
      body.put("newArticles", 0);
      body.put("newUsers", 0);
      body.put("newComments", 0);
      body.put("newSeries", 0);
      body.put("tipCount", 0);
      body.put("tipInk", 0);
      return body;
    }
    body.put("newArticles", NodeShapes.num(row.getNewArticles()));
    body.put("newUsers", NodeShapes.num(row.getNewUsers()));
    body.put("newComments", NodeShapes.num(row.getNewComments()));
    body.put("newSeries", NodeShapes.num(row.getNewSeries()));
    body.put("tipCount", NodeShapes.num(row.getTipCount()));
    body.put("tipInk", NodeShapes.num(row.getTipInk()));
    return body;
  }
}
