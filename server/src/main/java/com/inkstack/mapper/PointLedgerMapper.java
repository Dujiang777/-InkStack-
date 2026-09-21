package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface PointLedgerMapper {

  @Insert("INSERT INTO point_ledger (user_id, delta, reason) VALUES (#{userId}, #{delta}, #{reason})")
  int insert(
      @Param("userId") long userId,
      @Param("delta") long delta,
      @Param("reason") String reason);
}
