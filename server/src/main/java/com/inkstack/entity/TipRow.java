package com.inkstack.entity;

import lombok.Data;

/** 「最新墨水」打赏动态行。createdAt 已在 SQL 里 DATE_FORMAT 成 MM-DD HH:mm（刻意不含年份）。 */
@Data
public class TipRow {

  private String fromName;
  private String fromAvatar;
  private Long amount;
  private String createdAt;
}
