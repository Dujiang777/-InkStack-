package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * 作者/标签文章列表的原始行。两个查询的列集合是"并集"：
 * 标签页 SQL 不选 unlockPrice/discountPrice/discountUntil（Node 版同样不选），
 * 这三列在标签路径下保持 null，由视图决定要不要输出——视图不能替查询凭空造字段。
 */
@Data
public class AuthorArticle {

  private String slug;
  private String title;
  private String author;
  private String authorAvatar;
  private Long authorId;
  private String summary;
  private String coverLabel;
  private String tags;
  private Long readCount;
  private Long commentCount;
  private Long agentQaCount;
  private Long likeCount;
  private String publishedAt;
  private Long tipTotal;
  private Long unlockPrice;
  private Long discountPrice;
  private LocalDateTime discountUntil;
}
