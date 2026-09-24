package com.inkstack.mapper;

import com.inkstack.entity.RagRows.ArticleMd;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface RagMapper {

  /**
   * 分身问答的语料检索，逐字对应 {@code lib/rag.ts} 的那条语句。
   *
   * <p>付费墙那一支是这条 SQL 存在的全部理由：读者花 5 点墨问一句，若未解锁的付费正文进了
   * 检索语料，分身就会把付费内容复述给提问的人——绕过 unlock。所以"作者本人 / 已购买"之外
   * 一律不取。
   *
   * <p>{@code me=0} 表示游客：作者 id 恒 &gt; 0、游客不会有购买记录，传 0 与"按未解锁处理"等价，
   * 不必为游客单拆一条分支（少一条分支就少一处两栈走岔的机会）。
   */
  @Select("""
      SELECT title, md_content AS md
        FROM articles
       WHERE status = 'published'
         AND review_status = 'approved'
         AND MATCH(title, md_content) AGAINST(#{question} IN NATURAL LANGUAGE MODE)
         AND (IFNULL(unlock_price,0) = 0
              OR author_id = #{me}
              OR EXISTS (SELECT 1 FROM article_purchases p
                          WHERE p.article_id = articles.id AND p.user_id = #{me}))
       LIMIT 3
      """)
  List<ArticleMd> retrieve(@Param("question") String question, @Param("me") long me);
}
