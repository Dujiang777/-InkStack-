package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * 行为奖励的每日计数表。判重靠唯一键 (user_id, cap_key, cnt_day)，
 * 与 Node 的 grantCappedReward 共用同一条 ON DUPLICATE 语句。
 */
@Mapper
public interface RewardCounterMapper {

  @Insert("""
      INSERT INTO reward_counters (user_id, cap_key, cnt_day, cnt) VALUES (#{userId}, #{capKey}, #{day}, 1)
      ON DUPLICATE KEY UPDATE cnt = cnt + 1
      """)
  int bump(
      @Param("userId") long userId,
      @Param("capKey") String capKey,
      @Param("day") String day);

  @Select("""
      SELECT cnt FROM reward_counters
       WHERE user_id = #{userId} AND cap_key = #{capKey} AND cnt_day = #{day} LIMIT 1
      """)
  Long countOf(
      @Param("userId") long userId,
      @Param("capKey") String capKey,
      @Param("day") String day);
}
