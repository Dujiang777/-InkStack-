package com.inkstack.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.inkstack.entity.MoneyRows;
import com.inkstack.entity.User;
import java.time.LocalDate;
import java.util.List;
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

  @Select("SELECT id, nickname, email, password_hash AS passwordHash, role, totp_secret AS totpSecret,"
      + " totp_enabled AS totpEnabled, totp_backup AS totpBackup, points_balance AS pointsBalance"
      + " FROM users WHERE id = #{uid} LIMIT 1")
  User byIdForSecurity(@Param("uid") long uid);

  @Update("UPDATE users SET totp_secret = #{secret}, totp_enabled = 0 WHERE id = #{uid}")
  int stageTotpSecret(@Param("uid") long uid, @Param("secret") String secret);

  @Update("UPDATE users SET totp_enabled = 1, totp_backup = #{backupJson} WHERE id = #{uid}")
  int commitTotp(@Param("uid") long uid, @Param("backupJson") String backupJson);

  @Update("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_backup = NULL WHERE id = #{uid}")
  int clearTotp(@Param("uid") long uid);

  /**
   * OAuth 建档/登录合一。<b>用 affectedRows 而不是 insertId 判"是不是新号"</b>：
   * MySQL 对 {@code ON DUPLICATE KEY UPDATE} 插入返回 1、更新返回 2、值没变返回 0，
   * 三种情况下 insertId 分别是新自增值 / 0 / 0——两种写法等价，但 affectedRows 不依赖
   * 驱动是否愿意在更新分支回一行 generated keys。
   */
  @Insert("INSERT INTO users (nickname, email, password_hash, avatar_text, bio)"
      + " VALUES (#{nickname}, #{email}, #{passwordHash}, #{avatarText}, #{bio})"
      + " ON DUPLICATE KEY UPDATE nickname = VALUES(nickname),"
      + " bio = IF(bio IS NULL OR bio = '', VALUES(bio), bio)")
  int upsertOauth(
      @Param("nickname") String nickname,
      @Param("email") String email,
      @Param("passwordHash") String passwordHash,
      @Param("avatarText") String avatarText,
      @Param("bio") String bio);

  /** 不带 bio 列的那家（QQ）：与 Node 的语句同样逐字分开，别合成一条。 */
  @Insert("INSERT INTO users (nickname, email, password_hash, avatar_text)"
      + " VALUES (#{nickname}, #{email}, #{passwordHash}, #{avatarText})"
      + " ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)")
  int upsertOauthNoBio(
      @Param("nickname") String nickname,
      @Param("email") String email,
      @Param("passwordHash") String passwordHash,
      @Param("avatarText") String avatarText);

  @Select("SELECT id FROM users WHERE email = #{email} LIMIT 1")
  Long idByEmail(@Param("email") String email);

  /**
   * 书房「印章工坊」保存资料。五个字段一并覆盖，空值口径由服务层算好：
   * {@code avatar_text} 空时落昵称首字、{@code bio} 空时落 NULL（Node 的 {@code bio || null}）。
   * 印泥色与印式已经过白名单，走到这里的只可能是色板 key 或空串。
   */
  @Update("""
      UPDATE users
         SET nickname = #{nickname}, avatar_text = #{avatarText},
             avatar_tone = #{avatarTone}, avatar_shape = #{avatarShape}, bio = #{bio}
       WHERE id = #{uid}
      """)
  int updateProfile(
      @Param("uid") long uid,
      @Param("nickname") String nickname,
      @Param("avatarText") String avatarText,
      @Param("avatarTone") String avatarTone,
      @Param("avatarShape") String avatarShape,
      @Param("bio") String bio);

  /* ===== 余额改写入口：全工程只有这五条语句允许动 points_balance（充值/退款/签到/分账/运营调整都走它们） ===== */

  /** 锁自己账户行后读余额。资金链路的扣款前置——不锁就有并发双花。 */
  @Select("SELECT points_balance FROM users WHERE id = #{uid} FOR UPDATE")
  Long lockBalance(@Param("uid") long uid);

  /**
   * 一条语句锁双方，<b>按 id 升序</b>。
   *
   * <p>顺序是重点：A 打赏 B、B 同时打赏 A 时，若各自按"先付款方后收款方"加锁就会交叉等待死锁；
   * 统一按主键升序则两笔请求以同一顺序取锁。Node 的 tipArticle 同式。
   */
  @Select("""
      SELECT id, points_balance AS pointsBalance FROM users
       WHERE id IN (#{a}, #{b}) ORDER BY id FOR UPDATE
      """)
  List<MoneyRows.Balance> lockPair(@Param("a") long a, @Param("b") long b);

  /** 扣款。与 {@link PointLedgerMapper#insert} 成对出现，缺一不可。 */
  @Update("UPDATE users SET points_balance = points_balance - #{amount} WHERE id = #{uid}")
  int spend(@Param("uid") long uid, @Param("amount") long amount);

  /** 入账。同上，必须与流水同事务。 */
  @Update("UPDATE users SET points_balance = points_balance + #{amount} WHERE id = #{uid}")
  int credit(@Param("uid") long uid, @Param("amount") long amount);

  /**
   * 运营台"扣回点墨"的<b>绝对值</b>写入：Node 先按真实余额算出 after 再整行覆盖，
   * 因为账面必须与余额同源——用 GREATEST 把差额掩盖掉，Σ流水 就会与余额永久对不上。
   * 只允许在 {@link #lockBalance} 之后调用，且必须与流水同事务。
   */
  @Update("UPDATE users SET points_balance = #{value} WHERE id = #{uid}")
  int setBalanceAbsolute(@Param("uid") long uid, @Param("value") long value);
}
