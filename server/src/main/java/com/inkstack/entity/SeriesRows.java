package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** 专栏读接口的原始行。 */
public final class SeriesRows {

  private SeriesRows() {}

  /** 合集架的一张卡。 */
  @Data
  public static class Card {
    private Long id;
    private String title;
    private String description;
    private LocalDateTime updatedAt;
    private Long bundlePrice;
    private String author;
    private String authorAvatar;
    private Long authorId;
    private Long articleCount;
    private Long totalReads;
    private Long soldCount;
  }

  /** 专栏落地页的头部。 */
  @Data
  public static class Head {
    private Long id;
    private String title;
    private String description;
    private Long bundlePrice;
    private String author;
    private String authorAvatar;
    private Long authorId;
  }

  /** 专栏落地页的一篇。 */
  @Data
  public static class Item {
    private String slug;
    private String title;
    private Long readCount;
    private LocalDateTime publishedAt;
    private Long authorId;
    private Long unlockPrice;
    private Long discountPrice;
    private LocalDateTime discountUntil;
    private Integer viewerUnlocked;
  }

  /** 打包购买聚合：人数与累计解锁篇次。 */
  @Data
  public static class Sold {
    private Long c;
    private Long unlocked;
  }

  /** 篇目重设时的 slug → 主键对照行。 */
  @Data
  public static class SlugId {
    private Long id;
    private String slug;
  }

  /** 新建专栏的入参行。{@code id} 由 {@code useGeneratedKeys} 回写，所以必须是对象而不是散参数。 */
  @Data
  public static class New {
    private Long id;
    private long authorId;
    private String title;
    private String description;
  }

  /** 要落进 {@code series_items} 的一篇：position 就是请求数组里的下标。 */
  @Data
  public static class Positioned {
    private Long articleId;
    private Integer position;

    public Positioned() {}

    public Positioned(Long articleId, int position) {
      this.articleId = articleId;
      this.position = position;
    }
  }
}
