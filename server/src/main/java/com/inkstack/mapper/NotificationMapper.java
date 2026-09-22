package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface NotificationMapper {

  /**
   * 站内信落库。Node 的成就领取那条语句显式写了 {@code is_read = 0}，
   * 本表该列 NOT NULL DEFAULT 0，省掉它落库结果一致，故两侧共用这一条。
   */
  @Insert("""
      INSERT INTO notifications (user_id, type, title, body, link)
       VALUES (#{userId}, #{type}, #{title}, #{body,jdbcType=VARCHAR}, #{link,jdbcType=VARCHAR})
      """)
  int insert(
      @Param("userId") long userId,
      @Param("type") String type,
      @Param("title") String title,
      @Param("body") String body,
      @Param("link") String link);
}
