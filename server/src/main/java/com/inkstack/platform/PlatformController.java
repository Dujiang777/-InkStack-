package com.inkstack.platform;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.StatRows;
import com.inkstack.mapper.StatsMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 首页的全站聚合读数：数据横幅与作者榜。
 *
 * <p>这两条是 P7f-1d 才补出来的——它们原本只在 Next 进程里被 Server Component 直调
 * （{@code lib/data.ts} 的 platformStats / topAuthors），从来没有 HTTP 面，所以双轨期的
 * 对拍、契约基线三道差分闸门都看不见它们。闸门 18 把这份清单数出来之后，才有一个端点
 * 可以承接"页面只渲染、数据全问 Java"这句话。
 */
@RestController
@RequestMapping("/api/platform")
public class PlatformController {

  private final StatsMapper stats;

  public PlatformController(StatsMapper stats) {
    this.stats = stats;
  }

  /** 一条单行聚合查询取不到时（库空 / 异常）Node 回四个 0，这里同式。 */
  @GetMapping("/stats")
  public Map<String, Object> stats() {
    StatRows.Platform row = stats.platformStats();
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("articles", row == null ? 0L : NodeShapes.num(row.getArticles()));
    body.put("authors", row == null ? 0L : NodeShapes.num(row.getAuthors()));
    body.put("qaTotal", row == null ? 0L : NodeShapes.num(row.getQaTotal()));
    body.put("tipsTotal", row == null ? 0L : NodeShapes.num(row.getTipsTotal()));
    return body;
  }

  /**
   * 作者榜。这条端点**没有 Node 时代的前身**（原来只是 Next 进程里的一个函数调用），
   * 所以它的契约由调用方唯一决定：lib/java-source.ts 的 remoteTopAuthors 只会传 5。
   * 上限夹到 50 是防御性的——榜单是全站 GROUP BY，放一个任意大的 limit 进来等于送人一个
   * 全库扫描的入口，而页面永远不需要更多。
   */
  @GetMapping("/top-authors")
  public Map<String, Object> topAuthors(@RequestParam(name = "limit", defaultValue = "5") int limit) {
    List<StatRows.AuthorRank> rows = stats.topAuthors(Math.max(1, Math.min(50, limit)));
    List<Map<String, Object>> authors = rows.stream().map(PlatformController::authorOf).toList();
    return Map.of("authors", authors);
  }

  /** 键序即 Node 返回对象的键序；头像缺字回"墨"，与 Node 的 ?? "墨" 同式。 */
  private static Map<String, Object> authorOf(StatRows.AuthorRank r) {
    Map<String, Object> one = new LinkedHashMap<>();
    one.put("id", NodeShapes.num(r.getId()));
    one.put("nickname", r.getNickname());
    one.put("avatarText", r.getAvatarText() == null || r.getAvatarText().isEmpty() ? "墨" : r.getAvatarText());
    one.put("avatarTone", NodeShapes.text(r.getAvatarTone()));
    one.put("avatarShape", NodeShapes.text(r.getAvatarShape()));
    one.put("likes", NodeShapes.num(r.getLikes()));
    one.put("articles", NodeShapes.num(r.getArticles()));
    one.put("readTotal", NodeShapes.num(r.getReadTotal()));
    return one;
  }
}
