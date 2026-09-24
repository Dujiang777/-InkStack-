package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AgentQaMapper {

  /**
   * 问答流水。三列的形状照抄 Node：{@code answer} 存的是占位串、{@code citations} 是 JSON 数组。
   *
   * <p>看着像 bug（真答案没落库），但它不是这次迁移的靶子：改它要连带动到
   * {@code agent_qa_count} 与成就统计的口径，双轨期两侧必须一起改，属于 P7 的事。
   */
  @Insert("""
      INSERT INTO agent_qa (question, answer, citations) VALUES (#{question}, #{answer}, #{citations})
      """)
  int insert(@Param("question") String question, @Param("answer") String answer,
      @Param("citations") String citations);
}
