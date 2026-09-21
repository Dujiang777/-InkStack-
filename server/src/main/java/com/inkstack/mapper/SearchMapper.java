package com.inkstack.mapper;

import com.inkstack.entity.SearchRow;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SearchMapper {

  /**
   * 全站搜索：标题/摘要/正文 LIKE。
   *
   * <p>付费墙纵深（这条 SQL 存在的核心理由）：未解锁的付费文**既不参与正文匹配、也不回传正文摘录**。
   * {@code locked} 判据在一条语句里出现两次（摘录用 + WHERE 用），两处必须是同一个表达式，
   * 否则正文 LIKE 就又变成一个可无限次探测"正文里有没有这个词"的 oracle。
   *
   * <p>Node 版对游客传 {@code me=0}（而不是跳过整个分支）：作者 id 恒 &gt; 0、游客永不购买，
   * 所以传 0 与"游客一律按未解锁"完全等价，这里同样不拆分支——少一条分支就少一处两侧走岔的机会。
   *
   * <p>{@code like} 的通配符转义在 Service 层做（与 Node 同位置），SQL 里不出现拼接。
   */
  @Select("""
      SELECT a.slug, a.title, a.summary, u.nickname AS author, a.author_id AS authorId, a.tags,
             a.read_count AS readCount, a.like_count AS likeCount, a.comment_count AS commentCount,
             DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
             IFNULL(a.unlock_price,0) AS unlockPrice,
             IFNULL(a.discount_price,0) AS discountPrice,
             a.discount_until AS discountUntil,
             IF(IFNULL(a.unlock_price,0) > 0 AND a.author_id <> #{me}
                  AND NOT EXISTS (SELECT 1 FROM article_purchases p
                                  WHERE p.article_id = a.id AND p.user_id = #{me}),
                NULL,
                (SELECT SUBSTRING(a.md_content,
                   GREATEST(1, LOCATE(#{kw}, a.md_content) - 40), 120))) AS hit
        FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
         AND (a.title LIKE #{like} OR a.summary LIKE #{like}
              OR (NOT (IFNULL(a.unlock_price,0) > 0 AND a.author_id <> #{me}
                       AND NOT EXISTS (SELECT 1 FROM article_purchases p
                                        WHERE p.article_id = a.id AND p.user_id = #{me}))
                  AND a.md_content LIKE #{like}))
       /* 相关度：标题命中 > 摘要命中 > 正文命中，同级按阅读量 */
       ORDER BY (a.title LIKE #{like}) DESC, (a.summary LIKE #{like}) DESC, a.read_count DESC
       LIMIT #{limit}
      """)
  List<SearchRow> search(
      @Param("kw") String kw,
      @Param("like") String like,
      @Param("me") long me,
      @Param("limit") int limit);
}
