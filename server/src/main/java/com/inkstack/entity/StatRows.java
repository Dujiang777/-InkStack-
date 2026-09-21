package com.inkstack.entity;

import lombok.Data;

/** 作者看板类查询的原始行。 */
public final class StatRows {

  private StatRows() {}

  /** 作品数据看板的一行。boostUntil 只被当作"是否在加热中"的真值用，取 ISO 串即可安全替换 Node 的 Date#toString。 */
  @Data
  public static class AuthorStat {
    private String slug;
    private String title;
    private String status;
    private String publishedAt;
    private Long readCount;
    private Long likeCount;
    private Long commentCount;
    private Long tipTotal;
    private java.time.LocalDateTime boostUntil;
  }

  @Data
  public static class Funnel {
    private String slug;
    private String title;
    private Long views;
    private Long paywallViews;
    private Long unlocks;
    private Long revenue;
  }

  @Data
  public static class UnlockIncome {
    private String slug;
    private String title;
    private Long price;
    private Long sales;
    private Long earned;
  }
}
