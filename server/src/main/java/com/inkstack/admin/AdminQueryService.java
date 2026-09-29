package com.inkstack.admin;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.AdminRows;
import com.inkstack.mapper.AdminReadMapper;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 运营台读侧（P7f-1e）：八张表的列表与大盘聚合。
 *
 * <p>这一层存在的理由是 {@code adminInsights}：它一半是 SQL、一半是 JS 组装
 * （14 天的轴、按天回填、90% 分账的展示值、标签并列时的先后）。那"一半 JS"必须逐字搬，
 * 否则大盘上会看到"数字对不上但说不出哪一格错了"。列表类只有形状转换，也放在这里，
 * 让控制器只剩门禁与状态码。
 *
 * <p>所有转换都按 {@code lib/data.ts} 迁走那 8 个函数的字段顺序与默认值来：
 * 键序是 JSON 的可见属性（Node 的回给页面就是这个顺序），{@code "—"} 这类占位串是页面文案的一部分。
 */
@Service
public class AdminQueryService {

  private static final Logger log = LoggerFactory.getLogger(AdminQueryService.class);

  /** 大盘趋势窗口，与 Node 的 DAYS_WINDOW 同值。 */
  private static final int DAYS_WINDOW = 14;
  private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("yyyy-MM-dd");
  private static final DateTimeFormatter LABEL = DateTimeFormatter.ofPattern("MM/dd", Locale.US);

  private final AdminReadMapper read;

  public AdminQueryService(AdminReadMapper read) {
    this.read = read;
  }

  /** 内容管理：最近 100 篇。 */
  public List<Map<String, Object>> articles() {
    List<Map<String, Object>> out = new ArrayList<>();
    for (AdminRows.Article r : read.articles()) {
      Map<String, Object> one = new LinkedHashMap<>();
      one.put("slug", r.getSlug());
      one.put("title", r.getTitle());
      one.put("author", r.getAuthor());
      one.put("status", r.getStatus());
      // 老库的 NULL 审核状态按"已过审"展示，这是页面一直在依赖的默认值
      one.put("reviewStatus", r.getReviewStatus() == null ? "approved" : r.getReviewStatus());
      one.put("pinned", NodeShapes.flag(r.getPinned()));
      one.put("featured", NodeShapes.flag(r.getFeatured()));
      one.put("readCount", NodeShapes.num(r.getReadCount()));
      one.put("commentCount", NodeShapes.num(r.getCommentCount()));
      one.put("publishedAt", r.getPublishedAt() == null ? "—" : r.getPublishedAt());
      one.put("unlockPrice", NodeShapes.num(r.getUnlockPrice()));
      out.add(one);
    }
    return out;
  }

  /** 审核队列。 */
  public List<Map<String, Object>> reviewQueue() {
    List<Map<String, Object>> out = new ArrayList<>();
    for (AdminRows.ReviewItem r : read.reviewQueue()) {
      Map<String, Object> one = new LinkedHashMap<>();
      one.put("slug", r.getSlug());
      one.put("title", r.getTitle());
      one.put("author", r.getAuthor());
      one.put("summary", NodeShapes.text(r.getSummary()));
      one.put("submittedAt", r.getSubmittedAt() == null ? "—" : r.getSubmittedAt());
      out.add(one);
    }
    return out;
  }

  /**
   * 用户管理。{@code q} 只有空白时 trim 完是空串，_like 变成 {@code %%}，
   * 于是 Node 那句 {@code WHERE ? = '%%' OR ...} 恒真——"搜索框留着"和"搜了个空格"是同一个结果，
   * 这里保持同一个结果。
   */
  public List<Map<String, Object>> users(String query) {
    String like = "%" + NodeShapes.jsTrim(query == null ? "" : query) + "%";
    List<Map<String, Object>> out = new ArrayList<>();
    for (AdminRows.UserRow r : read.users(like)) {
      Map<String, Object> one = new LinkedHashMap<>();
      one.put("id", NodeShapes.num(r.getId()));
      one.put("nickname", r.getNickname());
      one.put("email", r.getEmail());
      one.put("role", r.getRole());
      one.put("banned", NodeShapes.flag(r.getBanned()));
      one.put("points", NodeShapes.num(r.getPoints()));
      one.put("articleCount", NodeShapes.num(r.getArticleCount()));
      one.put("createdAt", r.getCreatedAt() == null ? "—" : r.getCreatedAt());
      out.add(one);
    }
    return out;
  }

  /** 举报队列；{@code status} 为 null 时回全部。 */
  public List<Map<String, Object>> reports(String status) {
    String wanted = status == null || status.isEmpty() ? null : status;
    List<Map<String, Object>> out = new ArrayList<>();
    for (AdminRows.ReportItem r : read.reports(wanted)) {
      Map<String, Object> one = new LinkedHashMap<>();
      one.put("id", NodeShapes.num(r.getId()));
      one.put("targetType", r.getTargetType());
      one.put("targetId", NodeShapes.num(r.getTargetId()));
      one.put("reason", r.getReason());
      one.put("status", r.getStatus());
      one.put("reporter", r.getReporter());
      one.put("targetTitle", r.getTargetTitle() == null ? "（内容已不存在）" : r.getTargetTitle());
      one.put("createdAt", r.getCreatedAt() == null ? "—" : r.getCreatedAt());
      out.add(one);
    }
    return out;
  }

  /**
   * 管理操作审计。limit 走 {@link #jsLimit}：Node 那句是 {@code Number(limit) || 30}，
   * 于是 "abc"、0、空串统统落成 30 而不是报错——运营台点了"更多"以外的东西也不该 500。
   */
  public List<Map<String, Object>> actions(String rawLimit) {
    int limit = jsLimit(rawLimit, 30);
    List<Map<String, Object>> out = new ArrayList<>();
    for (AdminRows.ActionLog r : read.actions(limit)) {
      Map<String, Object> one = new LinkedHashMap<>();
      one.put("id", NodeShapes.num(r.getId()));
      one.put("admin", r.getAdmin());
      one.put("action", r.getAction());
      one.put("targetType", r.getTargetType());
      one.put("targetId", NodeShapes.jsString(r.getTargetId()));
      // Node 写的是 `r.detail ? String(r.detail) : null`：空串也归 null，不是"有值但为空"
      one.put("detail", r.getDetail() == null || r.getDetail().isEmpty() ? null : r.getDetail());
      one.put("createdAt", r.getCreatedAt() == null ? "—" : r.getCreatedAt());
      out.add(one);
    }
    return out;
  }

  /** 资金流水（充值 / 单篇解锁 / 专栏打包合并后的最近 60 条）。 */
  public List<Map<String, Object>> orders() {
    List<Map<String, Object>> out = new ArrayList<>();
    for (AdminRows.Order r : read.orders()) {
      Map<String, Object> one = new LinkedHashMap<>();
      one.put("kind", NodeShapes.jsString(r.getKind()));
      one.put("user", NodeShapes.jsString(r.getUser()));
      one.put("title", NodeShapes.jsString(r.getTitle()));
      one.put("amount", NodeShapes.num(r.getAmount()));
      one.put("gain", NodeShapes.num(r.getGain()));
      one.put("createdAt", NodeShapes.jsString(r.getCreatedAt()));
      out.add(one);
    }
    return out;
  }

  /** 评论管理（最近 60 条，正文已在 SQL 里截 120 字）。 */
  public List<Map<String, Object>> comments() {
    List<Map<String, Object>> out = new ArrayList<>();
    for (AdminRows.CommentItem r : read.comments()) {
      Map<String, Object> one = new LinkedHashMap<>();
      one.put("id", NodeShapes.num(r.getId()));
      one.put("author", NodeShapes.jsString(r.getAuthor()));
      one.put("articleSlug", NodeShapes.jsString(r.getArticleSlug()));
      one.put("articleTitle", NodeShapes.jsString(r.getArticleTitle()));
      one.put("content", NodeShapes.jsString(r.getContent()));
      one.put("createdAt", NodeShapes.jsString(r.getCreatedAt()));
      out.add(one);
    }
    return out;
  }

  /**
   * 运营大盘。<b>整块失败时回"零值 + 完整时间轴"</b>，与 Node 的 catch 分支一字不差：
   * 轴必须还在，否则页面上一片空白，而"图是空的"和"取数挂了"在读者眼里是两件事。
   */
  public Map<String, Object> insights() {
    try {
      Map<String, Integer> index = new LinkedHashMap<>();
      List<Map<String, Object>> days = new ArrayList<>();
      LocalDate today = LocalDate.now();
      for (int i = DAYS_WINDOW - 1; i >= 0; i--) {
        LocalDate day = today.minusDays(i);
        String key = day.format(DAY);
        index.put(key, days.size());
        Map<String, Object> slot = new LinkedHashMap<>();
        slot.put("d", key);
        slot.put("label", day.format(LABEL));
        slot.put("articles", 0L);
        slot.put("users", 0L);
        slot.put("comments", 0L);
        days.add(slot);
      }
      fill(days, index, "articles", read.dailyArticles(DAYS_WINDOW - 1));
      fill(days, index, "users", read.dailyUsers(DAYS_WINDOW - 1));
      fill(days, index, "comments", read.dailyComments(DAYS_WINDOW - 1));

      AdminRows.Ink raw = read.ink();
      long tipTotal = NodeShapes.num(raw == null ? null : raw.getTipTotal());
      Map<String, Object> ink = new LinkedHashMap<>();
      ink.put("tipCount", NodeShapes.num(raw == null ? null : raw.getTipCount()));
      ink.put("tipTotal", tipTotal);
      // JS 的 Math.round 是"半数向上取"，Java 的 Math.round(double) 同定义；非负数下两者一致
      ink.put("authorGot", Math.round(tipTotal * 0.9));
      ink.put("topupCount", NodeShapes.num(raw == null ? null : raw.getTopupCount()));
      ink.put("topupTotal", NodeShapes.num(raw == null ? null : raw.getTopupTotal()));
      ink.put("qaCount", NodeShapes.num(raw == null ? null : raw.getQaCount()));

      List<Map<String, Object>> top = new ArrayList<>();
      for (AdminRows.TopArticle r : read.topArticles()) {
        Map<String, Object> one = new LinkedHashMap<>();
        one.put("slug", r.getSlug());
        one.put("title", r.getTitle());
        one.put("author", r.getAuthor());
        one.put("readCount", NodeShapes.num(r.getReadCount()));
        one.put("likeCount", NodeShapes.num(r.getLikeCount()));
        one.put("tipTotal", NodeShapes.num(r.getTipTotal()));
        top.add(one);
      }

      Map<String, Long> counter = new LinkedHashMap<>();
      for (String json : read.allTags()) {
        for (String tag : NodeShapes.tags(json)) {
          counter.merge(tag, 1L, Long::sum);
        }
      }
      List<Map.Entry<String, Long>> ranked = new ArrayList<>(counter.entrySet());
      ranked.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));
      List<Map<String, Object>> tags = new ArrayList<>();
      for (int i = 0; i < Math.min(8, ranked.size()); i++) {
        Map<String, Object> one = new LinkedHashMap<>();
        one.put("tag", ranked.get(i).getKey());
        one.put("count", ranked.get(i).getValue());
        tags.add(one);
      }

      Map<String, Object> funnel = emptyFunnel();
      try {
        AdminRows.FunnelRow f = read.funnel();
        if (f != null) {
          funnel = new LinkedHashMap<>();
          funnel.put("paidArticles", NodeShapes.num(f.getPaidArticles()));
          funnel.put("paywallViews", NodeShapes.num(f.getPaywallViews()));
          funnel.put("unlocks", NodeShapes.num(f.getUnlocks()));
          funnel.put("bundles", NodeShapes.num(f.getBundles()));
          funnel.put("revenue", NodeShapes.num(f.getUnlockRevenue()) + NodeShapes.num(f.getBundleRevenue()));
        }
      } catch (RuntimeException missingTable) {
        // series_purchases 不在了就退回空漏斗（Node 的注释写的是"老库可能还没补上这张表"）
        log.warn("漏斗取数失败，按空漏斗展示：{}", missingTable.getMessage());
      }

      Map<String, Object> out = new LinkedHashMap<>();
      out.put("days", days);
      out.put("ink", ink);
      out.put("topArticles", top);
      out.put("tags", tags);
      out.put("funnel", funnel);
      return out;
    } catch (RuntimeException failed) {
      log.warn("运营大盘取数失败，回零值：{}", failed.getMessage());
      Map<String, Object> zero = new LinkedHashMap<>();
      List<Map<String, Object>> days = new ArrayList<>();
      LocalDate today = LocalDate.now();
      for (int i = DAYS_WINDOW - 1; i >= 0; i--) {
        LocalDate day = today.minusDays(i);
        Map<String, Object> slot = new LinkedHashMap<>();
        slot.put("d", day.format(DAY));
        slot.put("label", day.format(LABEL));
        slot.put("articles", 0L);
        slot.put("users", 0L);
        slot.put("comments", 0L);
        days.add(slot);
      }
      zero.put("days", days);
      zero.put("ink", emptyInk());
      zero.put("topArticles", List.of());
      zero.put("tags", List.of());
      zero.put("funnel", emptyFunnel());
      return zero;
    }
  }

  private static void fill(List<Map<String, Object>> days, Map<String, Integer> index,
      String key, List<AdminRows.DayCount> counts) {
    for (AdminRows.DayCount c : counts) {
      Integer at = index.get(c.getD());
      if (at != null) {
        days.get(at).put(key, NodeShapes.num(c.getC()));
      }
    }
  }

  private static Map<String, Object> emptyInk() {
    Map<String, Object> ink = new LinkedHashMap<>();
    ink.put("tipCount", 0L);
    ink.put("tipTotal", 0L);
    ink.put("authorGot", 0L);
    ink.put("topupCount", 0L);
    ink.put("topupTotal", 0L);
    ink.put("qaCount", 0L);
    return ink;
  }

  private static Map<String, Object> emptyFunnel() {
    Map<String, Object> funnel = new LinkedHashMap<>();
    funnel.put("paidArticles", 0L);
    funnel.put("paywallViews", 0L);
    funnel.put("unlocks", 0L);
    funnel.put("bundles", 0L);
    funnel.put("revenue", 0L);
    return funnel;
  }

  /** {@code Number(x) || fallback}：非法值与 0 都落回默认（与 JS 同，包括 "0" 也算假值）。 */
  private static int jsLimit(String raw, int fallback) {
    double parsed = NodeShapes.jsNumber(raw);
    if (Double.isNaN(parsed) || parsed == 0) {
      return fallback;
    }
    return (int) parsed;
  }
}
