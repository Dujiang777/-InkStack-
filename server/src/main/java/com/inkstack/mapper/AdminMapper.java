package com.inkstack.mapper;

import com.inkstack.entity.AdminRows;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** 运营台四条写链路的 SQL，逐条对 lib/data.ts 的 admin* 函数。 */
@Mapper
public interface AdminMapper {

  /* ==================== 内容管理 ==================== */

  /**
   * 常规运营动作。{@code sql} 必须是 {@code AdminService.ACTION_SQL} 里的常量片段——
   * 这里用 ${} 拼接是因为 Node 就是把六种 SET 子句拼进同一条 UPDATE，
   * 白名单在服务层，绝不接受任何来自请求体的字符串。
   */
  @Update("UPDATE articles SET ${sql} WHERE slug = #{slug}")
  int setArticle(@Param("sql") String sql, @Param("slug") String slug);

  @Update("UPDATE articles SET review_status = #{status}, review_note = #{note} WHERE slug = #{slug}")
  int reviewArticle(
      @Param("status") String status, @Param("note") String note, @Param("slug") String slug);

  @Select("SELECT author_id AS authorId FROM articles WHERE slug = #{slug} LIMIT 1")
  Long authorOf(@Param("slug") String slug);

  /** 运营改价：折扣价 > 0 时把截止设成 7 天后（UTC 串），否则清空折扣。 */
  @Update("""
      UPDATE articles
         SET unlock_price = #{up}, discount_price = #{dp}, discount_until = #{until}
       WHERE slug = #{slug}
      """)
  int setPrice(
      @Param("up") long up, @Param("dp") long dp, @Param("until") String until, @Param("slug") String slug);

  /* ==================== 评论管理 ==================== */

  @Select("SELECT article_id AS articleId FROM comments WHERE id = #{id} FOR UPDATE")
  AdminRows.CommentOwner lockComment(@Param("id") long id);

  /** 删一条连带它的一级回复，否则留下指向已删父评论的孤楼。 */
  @Delete("DELETE FROM comments WHERE id = #{id} OR parent_id = #{id}")
  int deleteCommentTree(@Param("id") long id);

  @Update("UPDATE articles SET comment_count = GREATEST(0, comment_count - #{removed}) WHERE id = #{id}")
  int reclaimCommentCount(
      @Param("id") long id, @Param("removed") int removed);

  /* ==================== 举报处理 ==================== */

  @Select("""
      SELECT id, target_type AS targetType, target_id AS targetId
        FROM reports WHERE id = #{id} FOR UPDATE
      """)
  AdminRows.Report lockReport(@Param("id") long id);

  @Update("UPDATE articles SET status='removed', pinned=0, featured=0 WHERE id = #{id}")
  int removeArticleById(@Param("id") long id);

  @Delete("DELETE FROM comments WHERE id = #{id}")
  int deleteCommentById(@Param("id") long id);

  @Update("UPDATE reports SET status='resolved', handle_note = #{note}, handled_at = NOW() WHERE id = #{id}")
  int resolveReport(@Param("note") String note, @Param("id") long id);

  @Update("UPDATE reports SET status='dismissed', handle_note = #{note}, handled_at = NOW() WHERE id = #{id}")
  int dismissReport(@Param("note") String note, @Param("id") long id);

  /* ==================== 用户管理 ==================== */

  /** 封禁不许碰管理团队：条件写进语句里，affectedRows=0 就是"不存在或是同行"。 */
  @Update("UPDATE users SET banned = 1 WHERE id = #{id} AND role NOT IN ('admin','developer')")
  int ban(@Param("id") long id);

  @Update("UPDATE users SET banned = 0 WHERE id = #{id}")
  int unban(@Param("id") long id);

  @Select("SELECT role FROM users WHERE id = #{id} LIMIT 1")
  String roleOf(@Param("id") long id);

  @Update("UPDATE users SET role = #{role} WHERE id = #{id}")
  int setRole(@Param("role") String role, @Param("id") long id);

  /* ==================== 审计日志 ==================== */

  @Insert("""
      INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail)
       VALUES (#{adminId}, #{action}, #{targetType}, #{targetId}, #{detail,jdbcType=VARCHAR})
      """)
  int logAction(
      @Param("adminId") long adminId,
      @Param("action") String action,
      @Param("targetType") String targetType,
      @Param("targetId") String targetId,
      @Param("detail") String detail);

  /* ==================== 原文回填 ==================== */

  @Select("""
      SELECT slug, title, md_content AS md, summary, tags, cover_label AS coverLabel,
             review_status AS reviewStatus, review_note AS reviewNote, author_id AS authorId, status,
             IFNULL(unlock_price,0) AS unlockPrice,
             IFNULL(discount_price,0) AS discountPrice,
             discount_until AS discountUntil
        FROM articles WHERE slug = #{slug} LIMIT 1
      """)
  AdminRows.Raw raw(@Param("slug") String slug);
}
