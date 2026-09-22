package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * 墨水经济写链路的原始行。每个小结构对应 lib/data.ts 里某条 SELECT 的列，
 * 刻意不共用读侧的实体：写侧要的是"锁之前先看一眼"的最小列集，多带一列就多一次漂移可能。
 */
public final class MoneyRows {

  private MoneyRows() {}

  /** 解锁前置读：原价与折扣价分开带回，生效价在 Java 里算（与 Node 的 effectiveUnlockPrice 同式）。 */
  @Data
  public static class PayTarget {
    private Long id;
    private Long authorId;
    private Long price;
    private Long dprice;
    private LocalDateTime duntil;
  }

  /** 打赏的双行锁结果：一条语句锁双方，按 id 升序。 */
  @Data
  public static class Balance {
    private Long id;
    private Long pointsBalance;
  }

  @Data
  public static class BundleHead {
    private Long id;
    private Long authorId;
    private Long bundlePrice;
  }

  /** 打赏/加热共用的文章定位读：只要主键与作者，不碰正文。 */
  @Data
  public static class ArticleBrief {
    private Long id;
    private Long authorId;
  }

  /** 解锁成功后给作者发站内信用。 */
  @Data
  public static class ArticleRef {
    private Long authorId;
    private String title;
  }

  /** article_boosts 的一行：insertId 回填 id，boost_until 单独回读。 */
  @Data
  public static class Boost {
    private Long id;
    private Long articleId;
    private Long userId;
    private LocalDateTime boostUntil;
  }

  /** topup_orders 的支付前置读（FOR UPDATE）。 */
  @Data
  public static class TopupOrder {
    private String packKey;
    private Long points;
    private String status;
  }

  /**
   * 成就墙需要的八项计数，一句取全（Node 用 Promise.all 发八句，等价）。
   * 签到连签数不在这里：那是 Java 侧按日历日回推的算法，不是单条 SQL。
   */
  @Data
  public static class Badges {
    private Long articles;
    private Long reads;
    private Long likes;
    private Long comments;
    private Long balance;
    private Long following;
    private Long fans;
    private Long qa;
  }
}
