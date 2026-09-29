package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** 运营台与原文读取链路的行。 */
public final class AdminRows {

  private AdminRows() {}

  /** 举报处理的前置读：连目标一起带回，处理动作按 targetType 分叉。 */
  @Data
  public static class Report {
    private Long id;
    private String targetType;
    private Long targetId;
  }

  /** 评论删除的前置读：评论属于哪篇文章（回扣 comment_count 要用）。 */
  @Data
  public static class CommentOwner {
    private Long articleId;
  }

  /** 创作台回填用的原文行：与 Node 的 raw 接口同列、同别名。 */
  @Data
  public static class Raw {
    private String slug;
    private String title;
    private String md;
    private String summary;
    private String tags;
    private String coverLabel;
    private String reviewStatus;
    private String reviewNote;
    private Long authorId;
    private String status;
    private Long unlockPrice;
    private Long discountPrice;
    private LocalDateTime discountUntil;
  }

  /* ---------- 以下都是 P7f-1e 的运营台读行（原来住在 Next 进程里的 8 条直连 SQL） ---------- */

  /** 内容管理一张表。pinned/featured 是 tinyint，按项目惯例留 Integer 由 NodeShapes.flag 归真。 */
  @Data
  public static class Article {
    private String slug;
    private String title;
    private String author;
    private String status;
    private String reviewStatus;
    private Integer pinned;
    private Integer featured;
    private Long readCount;
    private Long commentCount;
    private Long unlockPrice;
    private String publishedAt;
  }

  /** 审核队列一行。submittedAt 是 '%m-%d %H:%i' 的成品串，不在 Java 里二次格式化。 */
  @Data
  public static class ReviewItem {
    private String slug;
    private String title;
    private String author;
    private String summary;
    private String submittedAt;
  }

  /** 用户管理一行（含邮箱——所以这条端点必须过运营门禁）。 */
  @Data
  public static class UserRow {
    private Long id;
    private String nickname;
    private String email;
    private String role;
    private Integer banned;
    private Long points;
    private Long articleCount;
    private String createdAt;
  }

  /** 举报队列一行。targetTitle 在目标已被删时为 NULL，由展示层落成"（内容已不存在）"。 */
  @Data
  public static class ReportItem {
    private Long id;
    private String targetType;
    private Long targetId;
    private String reason;
    private String status;
    private String reporter;
    private String targetTitle;
    private String createdAt;
  }

  /** 管理操作审计一行。targetId 在库里是变长列，Node 用 String() 包住，这里同样按字符串回。 */
  @Data
  public static class ActionLog {
    private Long id;
    private String admin;
    private String action;
    private String targetType;
    private String targetId;
    private String detail;
    private String createdAt;
  }

  /** 资金流水一行：充值 / 单篇解锁 / 专栏打包三段 UNION 后的统一形状。 */
  @Data
  public static class Order {
    private String kind;
    private String user;
    private String title;
    private Long amount;
    private Long gain;
    private String createdAt;
  }

  /** 评论管理一行，正文已在 SQL 里 LEFT(...,120) 截断。 */
  @Data
  public static class CommentItem {
    private Long id;
    private String author;
    private String articleSlug;
    private String articleTitle;
    private String content;
    private String createdAt;
  }

  /** 大盘趋势的一个点：'%Y-%m-%d' 与计数。 */
  @Data
  public static class DayCount {
    private String d;
    private Long c;
  }

  /** 大盘的墨水经济读数（authorGot 不在 SQL 里算，它是 90% 分账比例的展示值）。 */
  @Data
  public static class Ink {
    private Long tipCount;
    private Long tipTotal;
    private Long topupCount;
    private Long topupTotal;
    private Long qaCount;
  }

  /** 大盘热门榜一行。 */
  @Data
  public static class TopArticle {
    private String slug;
    private String title;
    private String author;
    private Long readCount;
    private Long likeCount;
    private Long tipTotal;
  }

  /** 大盘漏斗一行：解锁与打包两条收入流分开回，相加在 Java 侧做（Node 就是这么合的）。 */
  @Data
  public static class FunnelRow {
    private Long paidArticles;
    private Long paywallViews;
    private Long unlocks;
    private Long unlockRevenue;
    private Long bundles;
    private Long bundleRevenue;
  }
}
