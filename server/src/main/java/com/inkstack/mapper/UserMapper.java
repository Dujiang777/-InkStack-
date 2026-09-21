package com.inkstack.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.inkstack.entity.User;
import java.time.LocalDate;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Options;
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

  /**
   * 注册建号。列清单与 Node 完全一致：<b>不给 points_balance</b>，靠表上的
   * {@code DEFAULT 100} 落"注册即送 100 滴墨"——写死在代码里会和默认值漂移。
   * avatar_text 取昵称首字（Node 的 nickname.slice(0,1)，同为 UTF-16 码元语义）。
   */
  @Insert("INSERT INTO users (nickname, email, password_hash, avatar_text, role)"
      + " VALUES (#{nickname}, #{email}, #{passwordHash}, #{avatarText}, 'reader')")
  @Options(useGeneratedKeys = true, keyProperty = "id", keyColumn = "id")
  int insertRegistered(User user);

  @Select("SELECT id, totp_enabled AS totpEnabled, email FROM users WHERE email = #{email} LIMIT 1")
  User byEmailProbe(@Param("email") String email);

  @Update("UPDATE users SET password_hash = #{hash} WHERE id = #{uid}")
  int replacePassword(@Param("uid") long uid, @Param("hash") String hash);
}
