package com.inkstack.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
import com.inkstack.entity.ArticleWriteRows;

/**
 * 创作台的写侧 SQL：发布 / 存草稿 / 草稿转正 / 更新重审 / 撤回 / 硬删。
 *
 * <p>列清单与 Node 的 INSERT 逐字一致（含 {@code published_at} 只在正式发布那条里写 NOW()），
 * 少写一列就会表现为"Java 发的文章不在周报里 / 不在归档里"这类很难归因的读侧差异。
 */
@Mapper
public interface ArticleWriteMapper {

  /** slug 是否已被占：Node 的 uniqueSlug 与撞键重试都靠它。 */
  @Select("SELECT 1 FROM articles WHERE slug = #{slug} LIMIT 1")
  List<Integer> slugTaken(@Param("slug") String slug);

  @Insert("""
      INSERT INTO articles
        (author_id, slug, title, md_content, summary, cover_label, tags, status, review_status,
         unlock_price, discount_price, discount_until)
       VALUES (#{a.authorId}, #{slug}, #{a.title}, #{a.md}, #{a.summary}, #{a.coverLabel}, #{tagsJson},
               'draft', 'approved', #{a.unlockPrice}, #{a.discountPrice}, #{a.discountUntil})
      """)
  int insertDraft(@Param("a") ArticleWriteRows.Row a, @Param("slug") String slug,
      @Param("tagsJson") String tagsJson);

  @Insert("""
      INSERT INTO articles
        (author_id, slug, title, md_content, summary, cover_label, tags, status, review_status,
         unlock_price, discount_price, discount_until, published_at)
       VALUES (#{a.authorId}, #{slug}, #{a.title}, #{a.md}, #{a.summary}, #{a.coverLabel}, #{tagsJson},
               'published', #{a.reviewStatus}, #{a.unlockPrice}, #{a.discountPrice}, #{a.discountUntil}, NOW())
      """)
  int insertPublished(@Param("a") ArticleWriteRows.Row a, @Param("slug") String slug,
      @Param("tagsJson") String tagsJson);

  @Select("SELECT id, author_id AS authorId, status FROM articles WHERE slug = #{slug} LIMIT 1")
  ArticleWriteRows.Head head(@Param("slug") String slug);

  /** 存草稿：八个字段整行覆盖，状态不动（能进这条的必然是草稿，见服务层的前置判定）。 */
  @Update("""
      UPDATE articles
         SET title = #{a.title}, md_content = #{a.md}, summary = #{a.summary}, tags = #{tagsJson},
             cover_label = #{a.coverLabel}, unlock_price = #{a.unlockPrice},
             discount_price = #{a.discountPrice}, discount_until = #{a.discountUntil}
       WHERE id = #{id}
      """)
  int saveDraft(@Param("a") ArticleWriteRows.Row a, @Param("tagsJson") String tagsJson, @Param("id") long id);

  /** 草稿箱一键发布：只动状态三列，正文保持草稿原样。 */
  @Update("""
      UPDATE articles
         SET status = 'published', review_status = #{reviewStatus}, review_note = NULL,
             published_at = IF(published_at IS NULL, NOW(), published_at)
       WHERE id = #{id}
      """)
  int publishOnly(@Param("reviewStatus") String reviewStatus, @Param("id") long id);

  /** 更新并（可能首次）发布：published_at 只在 wasDraft 时补，否则编辑老文会改掉归档日期。 */
  @Update("""
      UPDATE articles
         SET title = #{a.title}, md_content = #{a.md}, summary = #{a.summary}, tags = #{tagsJson},
             cover_label = #{a.coverLabel}, unlock_price = #{a.unlockPrice},
             discount_price = #{a.discountPrice}, discount_until = #{a.discountUntil},
             status = 'published',
             review_status = #{reviewStatus}, review_note = NULL,
             published_at = IF(#{fromDraft} = 1 AND published_at IS NULL, NOW(), published_at)
       WHERE id = #{id}
      """)
  int updateAndPublish(@Param("a") ArticleWriteRows.Row a, @Param("tagsJson") String tagsJson,
      @Param("reviewStatus") String reviewStatus, @Param("fromDraft") int fromDraft, @Param("id") long id);

  @Update("UPDATE articles SET status = 'removed', pinned = 0, featured = 0 WHERE id = #{id}")
  int markRemoved(@Param("id") long id);

  /** 草稿硬删前清的子表：表名是代码内常量，绝不接外部输入。 */
  @Delete("DELETE FROM ${table} WHERE article_id = #{articleId}")
  int deleteChildren(@Param("table") String table, @Param("articleId") long articleId);

  @Delete("DELETE FROM articles WHERE id = #{id}")
  int deleteArticle(@Param("id") long id);

  /** 重新提审要挨个通知的运营账号。 */
  @Select("SELECT id FROM users WHERE role = 'admin' AND banned = 0")
  List<Long> adminIds();
}
