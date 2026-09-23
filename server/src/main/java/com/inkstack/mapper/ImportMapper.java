package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * 迁移工具写侧。列清单与 Node 的 INSERT 逐字一致——{@code cover_label} 固定"迁移"、
 * {@code review_status} 固定 pending（导入的稿子必须重新过审，不能因为是博主自己的就放行）。
 */
@Mapper
public interface ImportMapper {

  @Select("SELECT id FROM articles WHERE slug = #{slug} LIMIT 1")
  Long slugTaken(@Param("slug") String slug);

  /** 同作者同名判重：Node 也是先查后插，没建 (author_id, title) 唯一索引，两侧同口径。 */
  @Select("SELECT id FROM articles WHERE author_id = #{uid} AND title = #{title} LIMIT 1")
  Long dupeId(@Param("uid") long uid, @Param("title") String title);

  @Insert("""
      INSERT INTO articles
        (author_id, slug, title, md_content, summary, cover_label, tags, status, review_status,
         read_count, comment_count, agent_qa_count, published_at)
      VALUES (#{uid}, #{slug}, #{title}, #{md}, #{summary}, '迁移', #{tags}, 'published', 'pending',
         0, 0, 0, #{publishedAt})
      """)
  int insert(
      @Param("uid") long uid,
      @Param("slug") String slug,
      @Param("title") String title,
      @Param("md") String md,
      @Param("summary") String summary,
      @Param("tags") String tags,
      @Param("publishedAt") String publishedAt);
}
