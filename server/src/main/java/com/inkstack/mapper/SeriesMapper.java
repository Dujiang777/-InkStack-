package com.inkstack.mapper;

import com.inkstack.entity.SeriesHead;
import com.inkstack.entity.SeriesItem;
import com.inkstack.entity.SeriesRows;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SeriesMapper {

  /** 文章所属专栏；一篇可入多个专栏，取 position 最小的那个（与 Node 同规则）。 */
  @Select("""
      SELECT si.series_id AS seriesId, si.article_id AS articleId, a.slug, s.title
        FROM articles a
        JOIN series_items si ON si.article_id = a.id
        JOIN series s ON s.id = si.series_id
       WHERE a.slug = #{slug} ORDER BY si.position LIMIT 1
      """)
  SeriesItem seriesOfArticle(@Param("slug") String slug);

  /** 专栏内已发布且过审的篇目，按 position 定序（上下篇由此算出，不用 SQL 的 position 值）。 */
  @Select("""
      SELECT si.series_id AS seriesId, si.article_id AS articleId, a.slug, a.title
        FROM series_items si JOIN articles a ON a.id = si.article_id
       WHERE si.series_id = #{seriesId} AND a.status = 'published' AND a.review_status = 'approved'
       ORDER BY si.position, si.article_id
      """)
  List<SeriesItem> publishedItems(@Param("seriesId") long seriesId);

  @Select("SELECT id FROM articles WHERE slug = #{slug} LIMIT 1")
  Long articleIdOfSlug(@Param("slug") String slug);

  /** 书房管理器：本人全部专栏（含空柜），按更新时间倒序。 */
  @Select("SELECT id, title, description FROM series WHERE author_id = #{authorId} ORDER BY updated_at DESC")
  List<SeriesHead> listMine(@Param("authorId") long authorId);

  /** 批量取篇目：IN 用 foreach 展开占位符，绝不拼用户输入（Node 版拼的是同样安全的 "?" 串）。 */
  @Select("""
      <script>
      SELECT si.series_id AS seriesId, si.article_id AS articleId, a.slug, a.title
        FROM series_items si JOIN articles a ON a.id = si.article_id
       WHERE si.series_id IN
       <foreach collection="ids" item="id" open="(" separator="," close=")">#{id}</foreach>
       ORDER BY si.position, si.article_id
      </script>
      """)
  List<SeriesItem> itemsOf(@Param("ids") List<Long> ids);

  /**
   * 合集架的一张卡。
   *
   * <p>两个计数口径<b>不等</b>，是 Node 原样而非笔误：{@code articleCount} 数的是
   * {@code si.article_id}，LEFT JOIN 掉到未过审篇目时它仍然计数；{@code totalReads} 走
   * {@code a.read_count}，草稿进来的是 NULL、被 SUM 忽略。改成一致就等于改了页面显示的篇数。
   */
  @Select("""
      <script>
      SELECT s.id, s.title, s.description, s.updated_at AS updatedAt, s.bundle_price AS bundlePrice,
             u.nickname AS author, u.avatar_text AS authorAvatar, u.id AS authorId,
             COUNT(si.article_id) AS articleCount,
             COALESCE(SUM(a.read_count), 0) AS totalReads,
             (SELECT IFNULL(SUM(sp.item_count),0) FROM series_purchases sp WHERE sp.series_id = s.id) AS soldCount
        FROM series s
        JOIN users u ON u.id = s.author_id
        LEFT JOIN series_items si ON si.series_id = s.id
        LEFT JOIN articles a ON a.id = si.article_id
             AND a.status = 'published' AND a.review_status = 'approved'
       <if test="authorId != null">WHERE s.author_id = #{authorId}</if>
       GROUP BY s.id ORDER BY s.updated_at DESC LIMIT #{limit}
      </script>
      """)
  List<SeriesRows.Card> cards(@Param("authorId") Long authorId, @Param("limit") int limit);

  @Select("""
      SELECT s.id, s.title, s.description, s.bundle_price AS bundlePrice,
             u.nickname AS author, u.avatar_text AS authorAvatar, u.id AS authorId
        FROM series s JOIN users u ON u.id = s.author_id WHERE s.id = #{id} LIMIT 1
      """)
  SeriesRows.Head detailHead(@Param("id") long id);

  /** 落地页篇目：只列已发布且过审；viewerUnlocked 在 SQL 里判，游客分支直接 FALSE。 */
  @Select("""
      <script>
      SELECT a.slug, a.title, a.read_count AS readCount, a.published_at AS publishedAt,
             a.author_id AS authorId,
             IFNULL(a.unlock_price,0) AS unlockPrice,
             IFNULL(a.discount_price,0) AS discountPrice, a.discount_until AS discountUntil,
             <choose>
               <when test="viewerId != null">
                 EXISTS(SELECT 1 FROM article_purchases p WHERE p.article_id = a.id AND p.user_id = #{viewerId}) AS viewerUnlocked
               </when>
               <otherwise>FALSE AS viewerUnlocked</otherwise>
             </choose>
        FROM series_items si JOIN articles a ON a.id = si.article_id
       WHERE si.series_id = #{seriesId} AND a.status = 'published' AND a.review_status = 'approved'
       ORDER BY si.position, si.article_id
      </script>
      """)
  List<SeriesRows.Item> detailItems(
      @Param("seriesId") long seriesId, @Param("viewerId") Long viewerId);

  /** 打包已购：viewer 为 null 时不查（Node 传 0，0 号用户不存在，等价于恒不命中）。 */
  @Select("SELECT 1 FROM series_purchases WHERE series_id = #{seriesId} AND user_id = #{userId} LIMIT 1")
  Integer bundlePurchasedBy(
      @Param("seriesId") long seriesId, @Param("userId") long userId);

  /** 打包累计：c=购买人数，unlocked=累计解锁篇次（落地页 soldCount 取后者）。 */
  @Select("""
      SELECT COUNT(*) AS c, IFNULL(SUM(item_count),0) AS unlocked
        FROM series_purchases WHERE series_id = #{seriesId}
      """)
  SeriesRows.Sold soldStats(@Param("seriesId") long seriesId);
}
