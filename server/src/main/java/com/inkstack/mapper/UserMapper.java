package com.inkstack.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.inkstack.entity.User;
import java.time.LocalDate;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface UserMapper extends BaseMapper<User> {

  @Select("SELECT id, nickname, email, password_hash, totp_secret, totp_enabled, totp_backup, role,"
      + " points_balance, banned FROM users WHERE email = #{email} LIMIT 1")
  User findByLoginEmail(@Param("email") String email);

  @Update("UPDATE users SET totp_backup = #{backupJson} WHERE id = #{uid}")
  int replaceTotpBackup(@Param("uid") long uid, @Param("backupJson") String backupJson);

  /**
   * 每日免费额度的原子判重：靠"只有今天没发过才更新"这一条 UPDATE 的 affectedRows 定成败，
   * 不能先查后发（并发下会重复发墨）。
   */
  @Update("UPDATE users SET points_balance = points_balance + #{amount}, last_quota_date = #{today}"
      + " WHERE id = #{uid} AND (last_quota_date IS NULL OR last_quota_date < #{today})")
  int grantQuotaIfAbsent(
      @Param("uid") long uid,
      @Param("amount") long amount,
      @Param("today") LocalDate today);

  @Select("SELECT points_balance FROM users WHERE id = #{uid}")
  Long balanceOf(@Param("uid") long uid);
}
