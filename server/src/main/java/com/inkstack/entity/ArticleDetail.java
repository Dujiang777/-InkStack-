package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** 文章详情查询的原始行，与 lib/data.ts getArticle 的返回面逐项对齐。 */
@Data
public class ArticleDetail {

  private String slug;
  private String title;
  private String author;
  private String authorAvatar;
  private String authorTone;
  private String authorShape;
  private Long authorId;
  private String reviewStatus;
  private String reviewNote;
  private String summary;
  private String coverLabel;
  private String tags;
  private Long readCount;
  private Long commentCount;
  private Long agentQaCount;
  private Long likeCount;
  private String md;
  private Long unlockPrice;
  private Long discountPrice;
  private LocalDateTime discountUntil;
  private Long unlockCount;
  private String publishedAt;
  private LocalDateTime boostUntil;
  private Long tipTotal;
  /** EXISTS()/IF() 在 MySQL 侧回 0/1，转换层再按 ==1 归真。 */
  private Integer viewerLiked;
  private Integer viewerUnlocked;
}
