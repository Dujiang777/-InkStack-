package com.inkstack.mapper;

import com.inkstack.entity.SeriesHead;
import com.inkstack.entity.SeriesItem;
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
}
