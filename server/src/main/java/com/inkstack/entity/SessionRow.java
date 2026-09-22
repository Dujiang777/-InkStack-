package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * 设备管理列表的一行。时间保持原始 DATETIME，由视图统一成 ISO——
 * Node 原先输出 {@code String(Date)}（"Mon Sep 21 2026 … GMT+0800 (中国标准时间)"），
 * 而前端 fmtTime 用 {@code new Date(s.replace(" ", "T"))} 解析，这种串必然解析失败，
 * 于是设备时间一直显示 "Invalid Date"。两栈要能逐字段对拍，就必须先统一到 toISOString 口径。
 */
@Data
public class SessionRow {

  private Long id;
  private String tokenHash;
  private String ua;
  private String ip;
  private LocalDateTime createdAt;
  private LocalDateTime lastSeenAt;
}
