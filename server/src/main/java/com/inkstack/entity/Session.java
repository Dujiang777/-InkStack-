package com.inkstack.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/** sessions 表：服务器端会话登记，支撑设备管理与强制下线（纯无状态 Cookie 做不到）。 */
@Data
@TableName("sessions")
public class Session {

  @TableId(type = IdType.AUTO)
  private Long id;

  private Long userId;
  private String tokenHash;
  private String ua;
  private String ip;
  private LocalDateTime createdAt;
  private LocalDateTime lastSeenAt;
  private LocalDateTime expiresAt;
  private Integer revoked;
}
