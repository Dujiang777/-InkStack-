package com.inkstack.mapper;

import com.inkstack.entity.SeriesHead;
import com.inkstack.entity.SeriesItem;
import com.inkstack.entity.SeriesRows;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Options;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

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

  /* ==================== 写侧：书房里的新建 / 改柜 / 删柜 ==================== */

  /**
   * 新建专栏。生成键回写进入参对象的 {@code id}——{@code useGeneratedKeys} 只认对象参数，
   * 标量参数表拿不回自增值，而"建完立刻把 id 回给前端"是这条接口的全部产出。
   */
  @Insert("""
      INSERT INTO series (author_id, title, description)
       VALUES (#{authorId}, #{title}, #{description})
      """)
  @Options(useGeneratedKeys = true, keyProperty = "id", keyColumn = "id")
  int insertSeries(SeriesRows.New newSeries);

  /**
   * 改元信息。<b>三个 SET 子句恒定存在、用 IF 决定要不要覆盖</b>，而不是按入参拼 SQL：
   * Node 那边是动态拼 {@code sets[]}，但"未传的列保持原值"与"传了却与现值相同"在
   * affectedRows 上本来就无法区分，写死三条 + IF 既免掉拼串又保住这个语义。
   * {@code bundlePrice} 可以真的是 NULL（关闭打包），所以 jdbcType 必须给。
   */
  @Update("""
      UPDATE series
         SET title = IF(#{setTitle}, #{title}, title),
             description = IF(#{setDescription}, #{description}, description),
             bundle_price = IF(#{setBundlePrice}, #{bundlePrice,jdbcType=INTEGER}, bundle_price)
       WHERE id = #{id} AND author_id = #{authorId}
      """)
  int updateMeta(
      @Param("id") long id,
      @Param("authorId") long authorId,
      @Param("setTitle") boolean setTitle,
      @Param("title") String title,
      @Param("setDescription") boolean setDescription,
      @Param("description") String description,
      @Param("setBundlePrice") boolean setBundlePrice,
      @Param("bundlePrice") Integer bundlePrice);

  /** 删柜。条目靠 {@code ON DELETE CASCADE} 走，所以不需要先清 series_items。 */
  @Delete("DELETE FROM series WHERE id = #{id} AND author_id = #{authorId}")
  int deleteOwned(@Param("id") long id, @Param("authorId") long authorId);

  /** 重设篇目前先锁柜：同一专栏的并发重设必须串行，否则 DELETE 已提交而 INSERT 撞主键。 */
  @Select("SELECT id FROM series WHERE id = #{id} AND author_id = #{authorId} LIMIT 1 FOR UPDATE")
  Long lockOwned(@Param("id") long id, @Param("authorId") long authorId);

  /** 只认"本人 + 已发布 + 已过审"。命中行数与入参篇数不等即整单拒，半收就是替别人改柜。 */
  @Select("""
      <script>
      SELECT id, slug FROM articles
       WHERE author_id = #{authorId} AND status = 'published' AND review_status = 'approved'
         AND slug IN
      <foreach collection="slugs" item="s" open="(" separator="," close=")">#{s}</foreach>
      </script>
      """)
  List<SeriesRows.SlugId> pickOwnPublished(
      @Param("authorId") long authorId, @Param("slugs") List<String> slugs);

  @Delete("DELETE FROM series_items WHERE series_id = #{seriesId}")
  int clearItems(@Param("seriesId") long seriesId);

  /** 多行 VALUES 一次落完：position 就是数组下标，整体重设的顺序只有这一处来源。 */
  @Insert("""
      <script>
      INSERT INTO series_items (series_id, article_id, position) VALUES
      <foreach collection="items" item="it" separator=",">
        (#{seriesId}, #{it.articleId}, #{it.position})
      </foreach>
      </script>
      """)
  int insertItems(
      @Param("seriesId") long seriesId, @Param("items") List<SeriesRows.Positioned> items);
}
