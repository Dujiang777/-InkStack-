package com.inkstack.entity;

import lombok.Data;

/** 设备管理列表的一行。时间串在 SQL 层就 DATE_FORMAT，避免两栈各做一次时区换算。 */
@Data
public class SessionRow {

  private Long id;
  private String tokenHash;
  private String ua;
  private String ip;
  private String createdAt;
  private String lastSeenAt;
}
