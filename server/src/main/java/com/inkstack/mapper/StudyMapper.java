package com.inkstack.mapper;

import com.inkstack.entity.StudyRows;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** 书房写侧的 SQL：草稿、阅读足迹、外链审核。逐条对 lib/data.ts 与 app/api/links。 */
@Mapper
public interface StudyMapper {

  /* ===== 草稿箱 ===== */

  /** 同名草稿按 (user_id, title) 唯一键覆盖，updatedAt 由列上的 ON UPDATE CURRENT_TIMESTAMP 自己走。 */
  @Insert("""
      INSERT INTO drafts (user_id, title, content) VALUES (#{uid}, #{title}, #{content})
       ON DUPLICATE KEY UPDATE content = VALUES(content)
      """)
  int upsertDraft(
      @Param("uid") long uid, @Param("title") String title, @Param("content") String content);

  @Select("""
      SELECT content, DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') AS updatedAt
        FROM drafts WHERE user_id = #{uid} AND title = #{title} LIMIT 1
      """)
  StudyRows.Draft draft(@Param("uid") long uid, @Param("title") String title);

  /* ===== 阅读足迹 ===== */

  /**
   * 记录一次阅读。与 Node 同一条"插入即 SELECT 文章 id"的写法：
   * slug 不存在或未发布时语句影响 0 行，天然什么都不记——不需要先查一次文章。
   */
  @Insert("""
      INSERT INTO read_history (user_id, article_id, read_times, read_at)
       SELECT #{uid}, id, 1, NOW() FROM articles WHERE slug = #{slug} AND status = 'published'
       ON DUPLICATE KEY UPDATE read_times = read_times + 1, read_at = NOW()
      """)
  int recordRead(@Param("uid") long uid, @Param("slug") String slug);

  /* ===== 外链审核 ===== */

  /** 域名唯一键已存在时只刷新 url（Node 同式），note 与 status 保持不动。 */
  @Insert("""
      INSERT INTO link_whitelist (domain, url, note, status)
       VALUES (#{domain}, #{url}, #{note}, 'pending')
       ON DUPLICATE KEY UPDATE url = VALUES(url)
      """)
  int submitLink(
      @Param("domain") String domain, @Param("url") String url, @Param("note") String note);

  @Select("""
      SELECT id, domain, url, note, status,
             DATE_FORMAT(created_at,'%m-%d %H:%i') AS createdAt
        FROM link_whitelist ORDER BY status ASC, created_at DESC LIMIT 50
      """)
  List<StudyRows.Link> listLinks();

  /** 审核：status 由服务层从 approve|reject 映射而来，请求里的任何其它字符串都到不了这条语句。 */
  @Update("UPDATE link_whitelist SET status = #{status} WHERE id = #{id}")
  int reviewLink(@Param("id") long id, @Param("status") String status);
}
