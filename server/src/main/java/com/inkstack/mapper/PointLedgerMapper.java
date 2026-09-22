package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface PointLedgerMapper {

  @Insert("INSERT INTO point_ledger (user_id, delta, reason) VALUES (#{userId}, #{delta}, #{reason})")
  int insert(
      @Param("userId") long userId,
      @Param("delta") long delta,
      @Param("reason") String reason);

  /**
   * 一次性奖励的判重锚点：没有"已领取"标记列，判重就是查有没有这条 reason 的流水。
   * 所以 reason 字符串是业务键，改一个字的代价是"全站用户都能再领一次"。
   */
  @Select("SELECT id FROM point_ledger WHERE user_id = #{userId} AND reason = #{reason} LIMIT 1")
  Long claimedByReason(@Param("userId") long userId, @Param("reason") String reason);
}
