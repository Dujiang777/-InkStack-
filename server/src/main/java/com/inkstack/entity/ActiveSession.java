package com.inkstack.entity;

import lombok.Data;

/**
 * sessions JOIN users 的校验结果行，列名对齐 Node getCurrentUser 的那条 SQL，
 * 靠 map-underscore-to-camel-case 自动落到字段上。
 */
@Data
public class ActiveSession {

  private Long sessionId;
  private String tokenHash;
  private Long userId;
  private String nickname;
  private String email;
  private String role;
  private Long pointsBalance;
  private Integer banned;
}
