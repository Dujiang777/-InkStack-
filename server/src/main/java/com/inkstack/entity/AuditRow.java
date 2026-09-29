package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * {@code audit_logs} 的一行（安全中心"全操作留痕"那 20 条）。
 *
 * <p>只取页面显示的那几列：{@code ua} 在表里有，但个人中心的设备列表才用它，
 * 这里刻意不查——留痕表里什么都有，读接口每多带一列就多一分外泄面。
 */
@Data
public class AuditRow {
  private Long id;
  private String event;
  private String ip;
  private String detail;
  private LocalDateTime createdAt;
}
