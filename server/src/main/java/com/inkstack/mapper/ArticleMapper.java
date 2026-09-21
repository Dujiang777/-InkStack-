package com.inkstack.mapper;

import com.inkstack.entity.ArticleDetail;
import com.inkstack.entity.FeedArticle;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
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

  /**
   * 单篇文章读取，含可见性与付费墙判定。
   *
   * <p>Node 版把四处分支拼成字符串数组、参数按下标手工对位（6 个 {@code ?} 与一个
   * 数组一一对应，是本项目最易移植出错的一段）。这里改用 MyBatis 命名参数 +
   * {@code <choose>}：同一变量可重复引用，分支与参数不再靠位置耦合，行为保持等价。
   *
   * <p>{@code full=false} 时正文在 <b>SQL 层</b>就被 SUBSTRING_INDEX 截成前 6 行——
   * 全文绝不进结果集。这是付费墙的兜底防线：一旦取回全文再在内存里裁，
   * dev 模式的 RSC 序列化会把未购正文一并写进 HTML。截断只能在这里做，不可上移。
   */
  @Select("""
      <script>
      SELECT a.slug, a.title, u.nickname AS author, IFNULL(u.avatar_text,'') AS authorAvatar,
             COALESCE(u.avatar_tone,'') AS authorTone, COALESCE(u.avatar_shape,'') AS authorShape,
             a.author_id AS authorId, a.review_status AS reviewStatus, a.review_note AS reviewNote,
             a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
             a.read_count AS readCount, a.comment_count AS commentCount,
             a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
             <choose>
               <when test="full">a.md_content AS md</when>
               <otherwise>SUBSTRING_INDEX(a.md_content, '\\n', 6) AS md</otherwise>
             </choose>
             ,IFNULL(a.unlock_price,0) AS unlockPrice,
             IFNULL(a.discount_price,0) AS discountPrice,
             a.discount_until AS discountUntil,
             (SELECT COUNT(*) FROM article_purchases pc WHERE pc.article_id = a.id) AS unlockCount,
             DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
             (SELECT MAX(b.boost_until) FROM article_boosts b
               WHERE b.article_id = a.id AND b.boost_until &gt; NOW()) AS boostUntil,
             (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t
               WHERE t.article_id = a.id) AS tipTotal,
             <choose>
               <when test="viewerId != null">
                 EXISTS(SELECT 1 FROM article_likes l WHERE l.article_id = a.id AND l.user_id = #{viewerId}) AS viewerLiked
               </when>
               <otherwise>FALSE AS viewerLiked</otherwise>
             </choose>
             ,
             <choose>
               <when test="viewerId != null">
                 IF(a.author_id = #{viewerId} OR #{privileged}, TRUE,
                    EXISTS(SELECT 1 FROM article_purchases p WHERE p.article_id = a.id AND p.user_id = #{viewerId})) AS viewerUnlocked
               </when>
               <otherwise>FALSE AS viewerUnlocked</otherwise>
             </choose>
        FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.slug = #{slug} AND a.status = 'published'
         AND (a.review_status = 'approved'
         <if test="viewerId != null">OR a.author_id = #{viewerId}</if>
         <if test="privileged">OR TRUE</if>
         )
       LIMIT 1
      </script>
      """)
  ArticleDetail findDetail(
      @Param("slug") String slug,
      @Param("viewerId") Long viewerId,
      @Param("privileged") boolean privileged,
      @Param("full") boolean full);
}
