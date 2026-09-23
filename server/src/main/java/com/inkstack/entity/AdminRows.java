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
}
