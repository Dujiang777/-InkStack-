package com.inkstack.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDate;
import lombok.Data;

/** users 表：仅声明本阶段用到的列，MyBatis-Plus 只会为已声明字段生成 SQL。 */
@Data
@TableName("users")
public class User {

  @TableId(type = IdType.AUTO)
  private Long id;

  private String nickname;
  private String email;
  private String passwordHash;
  private String role;
  private Long pointsBalance;
  private Integer banned;
  private String totpSecret;
  private Integer totpEnabled;
  private String totpBackup;
  private LocalDate lastQuotaDate;
}
