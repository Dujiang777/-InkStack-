package com.inkstack.mapper;

import com.inkstack.entity.AuditRow;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface AuditMapper {

  /** 审计写入失败绝不阻塞主流程，调用方负责吞异常（与 Node logAudit 同语义）。 */
  @Insert("INSERT INTO audit_logs (user_id, event, ip, ua, detail) VALUES ("
      + "#{userId,jdbcType=BIGINT}, #{event}, #{ip,jdbcType=VARCHAR}, #{ua,jdbcType=VARCHAR},"
      + " #{detail,jdbcType=VARCHAR})")
  int insert(
      @Param("userId") Long userId,
      @Param("event") String event,
      @Param("ip") String ip,
      @Param("ua") String ua,
      @Param("detail") String detail);

  /**
   * 某个账号最近的留痕（P7f-1f-a，从 {@code app/security/page.tsx} 搬来）。
   *
   * <p>{@code ORDER BY created_at DESC} 与页面原来那句一字同——这里不改成 {@code id DESC}：
   * 同一秒内多条留痕是常态（一次登录写两条），换排序键会改变第 20 条边界上落进来的是哪一条，
   * 而那正是这页唯一会被读者逐条核对的地方。
   */
  @Select("""
      SELECT id, event, ip, detail, created_at AS createdAt FROM audit_logs
       WHERE user_id = #{userId} ORDER BY created_at DESC LIMIT #{limit}
      """)
  List<AuditRow> recentForUser(@Param("userId") long userId, @Param("limit") int limit);
}
