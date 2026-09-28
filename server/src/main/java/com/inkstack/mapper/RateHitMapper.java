package com.inkstack.mapper;

import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * 限流命中流水（{@code rate_hits}）：一行一次命中，窗口判定按 bucket 聚合。
 *
 * <p>这张表是两栈共用的账本，Node 的 {@code lib/rate-limit.ts} 跑的是同一组 SQL 文本。
 * 窗口的时钟一律取 MySQL 的 {@code NOW(3)}——两栈的机器钟可以漂移，只有"现在是几点"也交给同一个源，
 * 同一个桶才会算出同一个解锁时间。
 */
@Mapper
public interface RateHitMapper {

  @Insert("INSERT INTO rate_hits (bucket, ts) VALUES (#{bucket}, NOW(3))")
  int insert(@Param("bucket") String bucket);

  /** 窗口内已记次数与最早一次命中距今的毫秒数（空桶为 n=0、ageMs=0）。 */
  @Select("""
      SELECT COUNT(*) AS n,
             COALESCE(ROUND((UNIX_TIMESTAMP(NOW(3)) - UNIX_TIMESTAMP(MIN(ts))) * 1000), 0) AS age_ms
        FROM rate_hits
       WHERE bucket = #{bucket} AND ts > DATE_SUB(NOW(3), INTERVAL #{seconds} SECOND)
      """)
  Window window(@Param("bucket") String bucket, @Param("seconds") int seconds);

  /** 逐桶清扫：命中时顺手做，保证窗口里的行数不会只增不减。 */
  @Delete("DELETE FROM rate_hits WHERE bucket = #{bucket} AND ts <= DATE_SUB(NOW(3), INTERVAL #{seconds} SECOND)")
  int prune(@Param("bucket") String bucket, @Param("seconds") int seconds);

  /** 成功后清零。 */
  @Delete("DELETE FROM rate_hits WHERE bucket = #{bucket}")
  int clear(@Param("bucket") String bucket);

  /** 全表清扫：桶名带邮箱和 IP，一次性桶再不会被读到，逐桶清扫永远碰不到它们。 */
  @Delete("DELETE FROM rate_hits WHERE ts < DATE_SUB(NOW(3), INTERVAL 86400 SECOND)")
  int sweepAll();

  /** window() 的行。 */
  class Window {

    private long n;
    private long ageMs;

    public long getN() {
      return n;
    }

    public void setN(long n) {
      this.n = n;
    }

    public long getAgeMs() {
      return ageMs;
    }

    public void setAgeMs(long ageMs) {
      this.ageMs = ageMs;
    }
  }
}
