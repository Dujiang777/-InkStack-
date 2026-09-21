package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** /api/articles 列表查询的原始行，列名与 Node listArticles 的 SQL 别名逐一对齐。 */
@Data
public class FeedArticle {

  private String slug;
  private String title;
  private String author;
  private String authorAvatar;
  private Long authorId;
  private String summary;
  private String coverLabel;
  /** tags 是 MySQL JSON 列；JDBC 侧拿到的是 JSON 文本，转换层再解析成数组。 */
  private String tags;
  private Long readCount;
  private Long commentCount;
  private Long agentQaCount;
  private Long likeCount;
  /** SQL 里已 DATE_FORMAT 成 yyyy-MM-dd；published_at 为 NULL 时回落空串（对齐 Node dateOnly）。 */
  private String publishedAt;
  private LocalDateTime boostUntil;
  private Long tipTotal;
  private Long unlockPrice;
  private Long discountPrice;
  private LocalDateTime discountUntil;
}
