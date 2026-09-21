package com.inkstack.mapper;

import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * 邮箱验证码表。表结构与 lib/verify-code.ts 的懒建表逐字一致（同一张表两栈共用，
 * 所以 DDL 必须等价，否则一侧建出来的列宽/索引不同）。
 */
@Mapper
public interface EmailCodeMapper {

  @Update("""
      CREATE TABLE IF NOT EXISTS email_codes (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email      VARCHAR(190) NOT NULL,
        code_hash  CHAR(64) NOT NULL,
        purpose    VARCHAR(20) NOT NULL DEFAULT 'register',
        attempts   INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        expires_at DATETIME(3) NOT NULL,
        INDEX idx_ec_email (email, created_at DESC)
      ) ENGINE=InnoDB
      """)
  int ensureTable();

  /** 锁住"最近 5 条"这一批行：冷却与窗口频控必须和后面的 INSERT 同事务，见 EmailCodeService。 */
  @Select("""
      SELECT created_at FROM email_codes
       WHERE email = #{email} AND purpose = #{purpose}
       ORDER BY id DESC LIMIT 5 FOR UPDATE
      """)
  List<LocalDateTime> lockRecent(@Param("email") String email, @Param("purpose") String purpose);

  @Insert("""
      INSERT INTO email_codes (email, code_hash, purpose, expires_at)
      VALUES (#{email}, #{codeHash}, #{purpose}, DATE_ADD(NOW(3), INTERVAL #{micros} MICROSECOND))
      """)
  int insert(
      @Param("email") String email,
      @Param("codeHash") String codeHash,
      @Param("purpose") String purpose,
      @Param("micros") long micros);

  @Select("""
      SELECT id, attempts, expires_at AS expiresAt FROM email_codes
       WHERE email = #{email} AND purpose = #{purpose} ORDER BY id DESC LIMIT 1
      """)
  CodeRow latest(@Param("email") String email, @Param("purpose") String purpose);

  @Select("SELECT code_hash FROM email_codes WHERE id = #{id} LIMIT 1")
  String hashOf(@Param("id") long id);

  /** 原子自增：读-改-写会让并发错误码把计数吞掉（Node 侧实测 60 并发只涨到 2）。 */
  @Update("UPDATE email_codes SET attempts = attempts + 1 WHERE id = #{id}")
  int bumpAttempts(@Param("id") long id);

  @Select("SELECT attempts FROM email_codes WHERE id = #{id} LIMIT 1")
  Integer attemptsOf(@Param("id") long id);

  @Delete("DELETE FROM email_codes WHERE id = #{id}")
  int deleteById(@Param("id") long id);

  /** 条件删除并核验影响行数：删掉了才算消费成功，天然幂等，没有"比对后再删"的竞态窗口。 */
  @Delete("DELETE FROM email_codes WHERE id = #{id} AND code_hash = #{codeHash}")
  int consume(@Param("id") long id, @Param("codeHash") String codeHash);

  /** latest() 的行。 */
  class CodeRow {

    private long id;
    private int attempts;
    private LocalDateTime expiresAt;

    public long getId() {
      return id;
    }

    public void setId(long id) {
      this.id = id;
    }

    public int getAttempts() {
      return attempts;
    }

    public void setAttempts(int attempts) {
      this.attempts = attempts;
    }

    public LocalDateTime getExpiresAt() {
      return expiresAt;
    }

    public void setExpiresAt(LocalDateTime expiresAt) {
      this.expiresAt = expiresAt;
    }
  }
}
