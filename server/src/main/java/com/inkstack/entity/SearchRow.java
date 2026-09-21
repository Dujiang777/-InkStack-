package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** 全站搜索的原始行，列别名与 Node searchArticles 一致。 */
@Data
public class SearchRow {

  private String slug;
  private String title;
  private String summary;
  private String author;
  private Long authorId;
  private String tags;
  private Long readCount;
  private Long likeCount;
  private Long commentCount;
  private String publishedAt;
  private String hit;
  private Long unlockPrice;
  private Long discountPrice;
  private LocalDateTime discountUntil;
}
