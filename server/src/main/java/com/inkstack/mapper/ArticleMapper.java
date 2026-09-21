package com.inkstack.mapper;

import com.inkstack.entity.ArticleDetail;
import com.inkstack.entity.AuthorArticle;
import com.inkstack.entity.FeedArticle;
import com.inkstack.entity.MeRows;
import com.inkstack.entity.StatRows;
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

  /**
   * 标签聚合页。{@code jsonTag} 由调用方拼成合法的 JSON 标量字面量（含引号、已转义），
   * 因为 JSON_CONTAINS 的第二参要的是 JSON 文档而不是字符串——Node 版就是在传参前做的同样加工，
   * 走占位符绑定，不参与 SQL 文本拼接。
   */
  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, u.avatar_text AS authorAvatar,
             a.author_id AS authorId,
             a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
             a.read_count AS readCount, a.comment_count AS commentCount,
             a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
             DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
             (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t
               WHERE t.article_id = a.id) AS tipTotal
        FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
         AND JSON_CONTAINS(a.tags, #{jsonTag})
       ORDER BY a.published_at DESC LIMIT #{limit}
      """)
  List<AuthorArticle> listByTag(@Param("jsonTag") String jsonTag, @Param("limit") int limit);

  /** 作者主页的公开文章列表：比标签页多三列定价、少一列 authorId（作者已由 WHERE 钉死）。 */
  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, u.avatar_text AS authorAvatar,
              a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
              a.read_count AS readCount, a.comment_count AS commentCount,
              a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
              DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
              (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t WHERE t.article_id = a.id) AS tipTotal,
              IFNULL(a.unlock_price,0) AS unlockPrice,
              IFNULL(a.discount_price,0) AS discountPrice,
              a.discount_until AS discountUntil
        FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.author_id = #{authorId} AND a.status = 'published' AND a.review_status = 'approved'
       ORDER BY a.published_at DESC LIMIT #{limit}
      """)
  List<AuthorArticle> listByAuthor(@Param("authorId") long authorId, @Param("limit") int limit);

  /**
   * 漫游记：随机取一篇公开且过审的文章。ORDER BY RAND() 在全表上是 O(n log n)，
   * 但本站文章量级下 Node 也是同一条语句——换栈期不改语义，性能留给 P7。
   */
  @Select("""
      SELECT slug FROM articles
       WHERE status = 'published' AND review_status = 'approved' AND slug <> #{exclude}
       ORDER BY RAND() LIMIT 1
      """)
  String randomSlug(@Param("exclude") String exclude);

  /* ---------- 创作台 /study 的作者自查读接口（全部按 author_id 圈定，无跨作者泄露） ---------- */

  /** 书房：本人全部文章，含待审/驳回/下架，所以 status 与 reviewStatus 都要带出去。 */
  @Select("""
      SELECT slug, title, status,
             review_status AS reviewStatus, review_note AS reviewNote,
             read_count AS readCount, like_count AS likeCount, comment_count AS commentCount,
             agent_qa_count AS agentQaCount,
             (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t WHERE t.article_id = a.id) AS tipTotal,
             (SELECT MAX(b.boost_until) FROM article_boosts b
               WHERE b.article_id = a.id AND b.boost_until > NOW()) AS boostUntil,
             DATE_FORMAT(updated_at,'%m-%d %H:%i') AS updatedAt
        FROM articles a WHERE author_id = #{userId}
        ORDER BY updated_at DESC LIMIT 100
      """)
  List<MeRows.Article> myArticles(@Param("userId") long userId);

  /** 书房看板汇总。published/totalReads 等口径都限定"已发布且过审"，drafts 与 tipIncome 是独立子查询。 */
  @Select("""
      SELECT
        COUNT(*) AS published,
        IFNULL(SUM(read_count),0) AS totalReads,
        IFNULL(SUM(like_count),0) AS totalLikes,
        IFNULL(SUM(agent_qa_count),0) AS totalQa,
        (SELECT COUNT(*) FROM articles WHERE author_id = #{userId} AND status = 'draft') AS drafts,
        (SELECT IFNULL(SUM(amount),0) FROM article_tips WHERE to_user = #{userId}) AS tipIncome
      FROM articles WHERE author_id = #{userId} AND status = 'published' AND review_status = 'approved'
      """)
  MeRows.ArticleStats myArticleStats(@Param("userId") long userId);

  /** 作品数据看板：含未发布以外的一切（只排 deleted），按阅读降序、同阅读按 id 降序保证稳定。 */
  @Select("""
      SELECT a.slug, a.title, a.status, DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
             a.read_count AS readCount, a.like_count AS likeCount, a.comment_count AS commentCount,
             IFNULL((SELECT SUM(t.amount) FROM article_tips t WHERE t.article_id = a.id), 0) AS tipTotal,
             (SELECT MAX(b.boost_until) FROM article_boosts b
               WHERE b.article_id = a.id AND b.boost_until > NOW()) AS boostUntil
        FROM articles a
       WHERE a.author_id = #{authorId} AND a.status <> 'deleted'
       ORDER BY GREATEST(a.read_count, 1) DESC, a.id DESC LIMIT #{limit}
      """)
  List<StatRows.AuthorStat> authorArticleStats(
      @Param("authorId") long authorId, @Param("limit") int limit);

  /** 付费转化漏斗：只看定价文章，按解锁数降序。 */
  @Select("""
      SELECT a.slug, a.title, a.read_count AS views, IFNULL(a.paywall_views,0) AS paywallViews,
             (SELECT COUNT(*) FROM article_purchases ap WHERE ap.article_id = a.id) AS unlocks,
             (SELECT IFNULL(SUM(ap.author_gain),0) FROM article_purchases ap WHERE ap.article_id = a.id) AS revenue
        FROM articles a
       WHERE a.author_id = #{authorId} AND a.status <> 'deleted' AND IFNULL(a.unlock_price,0) > 0
       ORDER BY unlocks DESC, a.read_count DESC LIMIT 30
      """)
  List<StatRows.Funnel> myFunnel(@Param("authorId") long authorId);

  /** 解锁收入明细：按成交价算，含"价格已改"的历史成交。总额与总单数在 Java 侧由明细汇总（与 Node 同法）。 */
  @Select("""
      SELECT a.slug, a.title, IFNULL(a.unlock_price,0) AS price,
             COUNT(p.id) AS sales, IFNULL(SUM(p.author_gain),0) AS earned
        FROM article_purchases p
        JOIN articles a ON a.id = p.article_id
       WHERE a.author_id = #{authorId}
       GROUP BY a.id, a.slug, a.title
       ORDER BY earned DESC, sales DESC
       LIMIT 20
      """)
  List<StatRows.UnlockIncome> myUnlockIncome(@Param("authorId") long authorId);
}
