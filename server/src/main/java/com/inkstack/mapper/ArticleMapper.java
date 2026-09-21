package com.inkstack.mapper;

import com.inkstack.entity.FeedArticle;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface ArticleMapper {

  /**
   * 首页杂志信息流。SQL 与 lib/data.ts listArticles 逐字对齐，三处易踩的点：
   *
   * <ul>
   *   <li>重力公式底数必须 GREATEST(...,1) 钳制——published_at 晚于 NOW() 时 POWER 负底数会
   *       让整条 SQL 抛 ER_DATA_OUT_OF_RANGE，历史上曾把整页静默降级到 demo 数据；</li>
   *   <li>排序即契约（置顶 &gt; 加热中 &gt; 重力），对拍按数组顺序逐项比；</li>
   *   <li>publishedAt 在 SQL 层就 DATE_FORMAT，Java 侧不再二次格式化，避免时区二义。</li>
   * </ul>
   */
  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, IFNULL(u.avatar_text,'') AS authorAvatar,
             a.author_id AS authorId,
             a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
             a.read_count AS readCount, a.comment_count AS commentCount,
             a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
             DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
             (SELECT MAX(b.boost_until) FROM article_boosts b
               WHERE b.article_id = a.id AND b.boost_until > NOW()) AS boostUntil,
             (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t
               WHERE t.article_id = a.id) AS tipTotal,
             IFNULL(a.unlock_price,0) AS unlockPrice,
             IFNULL(a.discount_price,0) AS discountPrice,
             a.discount_until AS discountUntil
        FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
       ORDER BY
         a.pinned DESC,
         EXISTS(SELECT 1 FROM article_boosts b
                WHERE b.article_id = a.id AND b.boost_until > NOW()) DESC,
         (LOG10(a.read_count + a.comment_count * 5 + a.agent_qa_count * 10 + 10))
         / POWER(GREATEST(TIMESTAMPDIFF(HOUR, a.published_at, NOW()) + 2, 1), 1.2)
      DESC LIMIT 50
      """)
  List<FeedArticle> listFeed();
}
