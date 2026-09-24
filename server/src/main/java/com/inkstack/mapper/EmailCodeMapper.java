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
 * 邮箱验证码表。表结构以 {@code db/schema.sql} 的 {@code email_codes} 为准（同一张表两栈共用，
 * Node 的 {@code lib/verify-code.ts} 也照着它懒建，所以列宽与索引必须等价）。
 *
 * <p>建表这件事以前在这里（一个 {@code @PostConstruct} 直接 {@code CREATE TABLE IF NOT EXISTS}），
 * P7b 收进 {@code SchemaBootstrap} 统一做：那个钩子连不上库时会把整个应用拖死，
 * 而且它让"关掉建库开关就真的什么都不建"这句话不成立。
 */
@Mapper
public interface EmailCodeMapper {

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
