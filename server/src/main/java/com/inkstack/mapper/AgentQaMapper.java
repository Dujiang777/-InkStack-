package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface AgentQaMapper {

  /**
   * 问答流水。四列的形状照抄 Node：{@code answer} 存的是占位串、{@code citations} 是 JSON 数组。
   *
   * <p>{@code asker_id} 不能留空：成就「十问分身」与 {@code badge-claim} 都是按
   * {@code COUNT(*) FROM agent_qa WHERE asker_id = ?} 算的，这一列为 NULL 就等于
   * 读者问了 100 次、进度条永远停在 0。
   *
   * <p>{@code article_id} 是 P8a 补上的一列（原来这条 INSERT 根本没有它）：读者站在某篇文章前
   * 问的分身，就该记在那篇文章名下。它同时是 {@code articles.agent_qa_count} 的唯一来源——
   * 文章页那句「分身已回答 N 次」以前只有种子写过一次，真实问答既不落文章也没有人 +1，
   * 于是那个数字永远冻在 1284。
   */
  @Insert("""
      INSERT INTO agent_qa (asker_id, article_id, question, answer, citations)
      VALUES (#{askerId}, #{articleId}, #{question}, #{answer}, #{citations})
      """)
  int insert(@Param("askerId") Long askerId, @Param("articleId") Long articleId,
      @Param("question") String question, @Param("answer") String answer,
      @Param("citations") String citations);

  /**
   * 按 slug 认领这篇文章。只认 {@code published}：把问答记进一篇草稿或未过审稿，等于让
   * 一个还没有公开的题目拿到重力排序的加成（排序式里有 {@code agent_qa_count * 10}）。
   * 认领不到就是 NULL——流水照记，只是不归属。
   */
  @Select("""
      SELECT id FROM articles WHERE slug = #{slug} AND status = 'published' LIMIT 1
      """)
  Long findPublishedIdBySlug(@Param("slug") String slug);

  /**
   * 计数 +1。写在这里而不是让调用方各写一遍：{@code agent_qa_count} 与
   * {@code COUNT(*) FROM agent_qa WHERE article_id = ?} 必须是同一件事的两个名字，
   * 所以它们只允许在同一个事务里被写（见 {@link com.inkstack.ai.AgentQaRecorder}）。
   */
  @Update("""
      UPDATE articles SET agent_qa_count = agent_qa_count + 1 WHERE id = #{articleId}
      """)
  int bumpQaCount(@Param("articleId") Long articleId);
}
