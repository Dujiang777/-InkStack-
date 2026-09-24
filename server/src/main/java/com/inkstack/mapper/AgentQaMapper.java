package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface AgentQaMapper {

  /**
   * 问答流水。四列的形状照抄 Node：{@code answer} 存的是占位串、{@code citations} 是 JSON 数组。
   *
   * <p>{@code answer} 看着像 bug（真答案没落库），但它不是这次迁移的靶子：改它要连带动到
   * {@code agent_qa_count} 的口径，双轨期两侧必须一起改，属于 P7 的事。
   *
   * <p>{@code asker_id} 则不能留空：成就「十问分身」与 {@code badge-claim} 都是按
   * {@code COUNT(*) FROM agent_qa WHERE asker_id = ?} 算的，这一列为 NULL 就等于
   * 读者问了 100 次、进度条永远停在 0。
   */
  @Insert("""
      INSERT INTO agent_qa (asker_id, question, answer, citations)
      VALUES (#{askerId}, #{question}, #{answer}, #{citations})
      """)
  int insert(@Param("askerId") Long askerId, @Param("question") String question,
      @Param("answer") String answer, @Param("citations") String citations);
}
