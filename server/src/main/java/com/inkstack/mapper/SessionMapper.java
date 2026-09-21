package com.inkstack.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.inkstack.entity.ActiveSession;
import com.inkstack.entity.Session;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface SessionMapper extends BaseMapper<Session> {

  /**
   * expires_at 用 FROM_UNIXTIME(秒) 写入，与 Node 侧完全一致：会话时效由 MySQL 会话时区
   * 解释，两栈必须走同一条路径，否则一侧认为有效、另一侧认为已过期。
   */
  @Insert("INSERT INTO sessions (user_id, token_hash, ua, ip, expires_at)"
      + " VALUES (#{userId}, #{tokenHash}, #{ua}, #{ip}, FROM_UNIXTIME(#{expSec}))")
  int register(
      @Param("userId") long userId,
      @Param("tokenHash") String tokenHash,
      @Param("ua") String ua,
      @Param("ip") String ip,
      @Param("expSec") long expSec);

  @Select("SELECT s.id AS session_id, s.token_hash AS token_hash, u.id AS user_id, u.nickname,"
      + " u.email, u.role, u.points_balance, u.banned"
      + " FROM sessions s JOIN users u ON u.id = s.user_id"
      + " WHERE s.token_hash = #{tokenHash} AND s.revoked = 0 AND s.expires_at > NOW() LIMIT 1")
  ActiveSession findActive(@Param("tokenHash") String tokenHash);

  @Update("UPDATE sessions SET revoked = 1 WHERE token_hash = #{tokenHash}")
  int revokeByTokenHash(@Param("tokenHash") String tokenHash);

  @Update("UPDATE sessions SET last_seen_at = NOW() WHERE id = #{id}")
  int touch(@Param("id") long id);

  @Select("SELECT COUNT(*) FROM sessions WHERE user_id = #{userId} AND ua = #{ua} AND revoked = 0")
  int countActiveByUa(@Param("userId") long userId, @Param("ua") String ua);
}
