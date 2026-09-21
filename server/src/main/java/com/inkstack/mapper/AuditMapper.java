package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

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
}
