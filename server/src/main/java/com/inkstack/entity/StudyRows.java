package com.inkstack.entity;

import lombok.Data;

/** 书房写侧（草稿箱 / 友链审核）的查询行。 */
public final class StudyRows {

  private StudyRows() {}

  /** {@code GET /api/drafts} 的两列——updated_at 已在 SQL 里 DATE_FORMAT 成串。 */
  @Data
  public static class Draft {
    private String content;
    private String updatedAt;
  }

  /** {@code GET /api/links} 的一行。createdAt 同样是 SQL 侧格式化的串。 */
  @Data
  public static class Link {
    private Long id;
    private String domain;
    private String url;
    private String note;
    private String status;
    private String createdAt;
  }
}
