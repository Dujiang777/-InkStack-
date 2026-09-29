package com.inkstack.mapper;

import com.inkstack.entity.MeRows;
import java.util.List;
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

  /**
   * 墨水账户页最近 20 条流水（P7f-1f-a，从 {@code app/points/page.tsx} 搬来）。
   *
   * <p>{@code ORDER BY id DESC} 而不是 created_at：同一毫秒落两条是常态（签到发墨与
   * 每日额度可能同刻），按 id 才是页面一直显示的那个先后。
   */
  @Select("""
      SELECT delta, reason, DATE_FORMAT(created_at, '%m-%d %H:%i') AS at
        FROM point_ledger WHERE user_id = #{userId} ORDER BY id DESC LIMIT #{limit}
      """)
  List<MeRows.Ledger> recentRows(@Param("userId") long userId, @Param("limit") int limit);
}
