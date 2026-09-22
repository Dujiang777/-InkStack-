package com.inkstack.mapper;

import com.inkstack.entity.CommunityRows;
import com.inkstack.entity.MoneyRows;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Options;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * 社区互动的写侧 SQL（P5a）。每条都与 lib/data.ts 里对应那条逐字对齐——
 * 包括"看起来多余"的部分：评论计数的 UPDATE 不带 status 条件、点赞的 GREATEST(0,…) 防负、
 * 收藏用 INSERT IGNORE 判态失败再 DELETE。改一个字就是两栈行为不同。
 */
@Mapper
public interface CommunityMapper {

  /* ==================== 评论发表 ==================== */

  @Insert("""
      INSERT INTO comments (article_id, user_id, guest_nickname, parent_id, content)
       SELECT id, #{userId}, #{guestNickname}, #{parentId}, #{content}
         FROM articles WHERE slug = #{slug} AND status = 'published'
      """)
  @Options(useGeneratedKeys = true, keyProperty = "id")
  int addComment(CommunityRows.CommentInsert row);

  @Update("UPDATE articles SET comment_count = comment_count + 1 WHERE slug = #{slug}")
  int bumpCommentCount(@Param("slug") String slug);

  /** 服务端时间，格式与 Node 的 DATE_FORMAT 一致（前端拿它替换占位行的 createdAt）。 */
  @Select("SELECT DATE_FORMAT(NOW(),'%Y-%m-%d %H:%i') AS createdAt")
  String nowText();

  /**
   * 回复目标校验：必须存在且属于同一篇文章（防跨文串楼）。
   *
   * <p>参数刻意收 double：Node 把 {@code Number(body.parentId)} 原样送进这句 SQL，
   * {@code 12.5} 这类值在 MySQL 侧就与任何 BIGINT 主键都不等 → 判"要回复的评论不存在"。
   * 这里若先转成 long，12.5 会命中 12 楼，两栈在同一个请求上给出不同结果。
   */
  @Select("""
      SELECT c.id FROM comments c JOIN articles a ON a.id = c.article_id
       WHERE c.id = #{parentId} AND a.slug = #{slug} LIMIT 1
      """)
  Long parentInArticle(
      @Param("parentId") double parentId, @Param("slug") String slug);

  /** 父评论昵称：前端回显回复对象用，查不到不影响主流程。收 double 的理由同上。 */
  @Select("""
      SELECT COALESCE(u.nickname, c.guest_nickname, '访客') AS nickname
        FROM comments c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = #{id} LIMIT 1
      """)
  CommunityRows.Nickname nicknameOf(@Param("id") double id);

  /** 被回复的评论人（游客楼层返回 null 行）。 */
  @Select("""
      SELECT c.user_id AS userId FROM comments c
       WHERE c.id = #{id} AND c.user_id IS NOT NULL LIMIT 1
      """)
  CommunityRows.ParentUser parentUserOf(@Param("id") double id);

  /** 评论奖励的前置读：Node 这句不筛 status，移植时不能加。 */
  @Select("SELECT id, author_id AS authorId FROM articles WHERE slug = #{slug} LIMIT 1")
  MoneyRows.ArticleBrief articleBySlug(@Param("slug") String slug);

  /* ==================== 文章点赞（toggle） ==================== */

  @Select("""
      SELECT id, author_id AS authorId, title FROM articles
       WHERE slug = #{slug} AND status = 'published' LIMIT 1
      """)
  CommunityRows.LikeTarget likeTarget(@Param("slug") String slug);

  @Select("SELECT 1 FROM article_likes WHERE user_id = #{userId} AND article_id = #{articleId} FOR UPDATE")
  List<Integer> lockLike(
      @Param("userId") long userId, @Param("articleId") long articleId);

  @Delete("DELETE FROM article_likes WHERE user_id = #{userId} AND article_id = #{articleId}")
  int deleteLike(
      @Param("userId") long userId, @Param("articleId") long articleId);

  @Insert("INSERT INTO article_likes (user_id, article_id) VALUES (#{userId}, #{articleId})")
  int insertLike(
      @Param("userId") long userId, @Param("articleId") long articleId);

  @Update("UPDATE articles SET like_count = GREATEST(0, like_count - 1) WHERE id = #{id}")
  int decLikeCount(@Param("id") long id);

  @Update("UPDATE articles SET like_count = like_count + 1 WHERE id = #{id}")
  int incLikeCount(@Param("id") long id);

  @Select("SELECT like_count AS likeCount FROM articles WHERE id = #{id}")
  Long likeCountOf(@Param("id") long id);

  /* ==================== 收藏（toggle） ==================== */

  @Select("SELECT id FROM articles WHERE slug = #{slug} AND status = 'published' LIMIT 1")
  Long publishedId(@Param("slug") String slug);

  /** affectedRows=1 即"这次真的收藏上了"，0 表示已存在 → 走取消。 */
  @Insert("INSERT IGNORE INTO bookmarks (user_id, article_id) VALUES (#{userId}, #{articleId})")
  int insertBookmarkIgnore(
      @Param("userId") long userId, @Param("articleId") long articleId);

  @Delete("DELETE FROM bookmarks WHERE user_id = #{userId} AND article_id = #{articleId}")
  int deleteBookmark(
      @Param("userId") long userId, @Param("articleId") long articleId);

  /* ==================== 评论点赞（toggle，无事务：与 Node 一致） ==================== */

  @Select("SELECT id FROM comment_likes WHERE comment_id = #{commentId} AND user_id = #{userId} LIMIT 1")
  Long commentLikeRow(
      @Param("commentId") long commentId, @Param("userId") long userId);

  @Delete("DELETE FROM comment_likes WHERE comment_id = #{commentId} AND user_id = #{userId}")
  int deleteCommentLike(
      @Param("commentId") long commentId, @Param("userId") long userId);

  @Insert("INSERT IGNORE INTO comment_likes (comment_id, user_id) VALUES (#{commentId}, #{userId})")
  int insertCommentLike(
      @Param("commentId") long commentId, @Param("userId") long userId);

  @Select("SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = #{commentId}")
  CommunityRows.Counter commentLikeCount(@Param("commentId") long commentId);

  /* ==================== 关注（toggle；是否已关注复用 SocialMapper.existsFollow） ==================== */

  @Delete("DELETE FROM follows WHERE follower_id = #{followerId} AND followee_id = #{followeeId}")
  int deleteFollow(
      @Param("followerId") long followerId, @Param("followeeId") long followeeId);

  @Insert("INSERT IGNORE INTO follows (follower_id, followee_id) VALUES (#{followerId}, #{followeeId})")
  int insertFollowIgnore(
      @Param("followerId") long followerId, @Param("followeeId") long followeeId);

  @Select("SELECT nickname FROM users WHERE id = #{id} LIMIT 1")
  CommunityRows.Nickname userNickname(@Param("id") long id);

  /* ==================== 举报（单事务 + 目标行 FOR UPDATE） ==================== */

  @Select("""
      SELECT id FROM articles WHERE slug = #{slug} AND status = 'published' LIMIT 1 FOR UPDATE
      """)
  CommunityRows.Anchor lockArticleAnchor(@Param("slug") String slug);

  @Select("SELECT id FROM comments WHERE id = #{id} LIMIT 1 FOR UPDATE")
  CommunityRows.Anchor lockCommentAnchor(@Param("id") long id);

  @Select("""
      SELECT 1 FROM reports
       WHERE reporter_id = #{reporterId} AND target_type = #{targetType}
         AND target_id = #{targetId} AND status = 'open' LIMIT 1
      """)
  List<Integer> openReport(
      @Param("reporterId") long reporterId,
      @Param("targetType") String targetType,
      @Param("targetId") long targetId);

  @Insert("""
      INSERT INTO reports (reporter_id, target_type, target_id, reason)
       VALUES (#{reporterId}, #{targetType}, #{targetId}, #{reason})
      """)
  int insertReport(
      @Param("reporterId") long reporterId,
      @Param("targetType") String targetType,
      @Param("targetId") long targetId,
      @Param("reason") String reason);

  /* ==================== 付费墙埋点 ==================== */

  /** 只给真付费墙计数：无价的公开文即使被打也一行不动。 */
  @Update("""
      UPDATE articles SET paywall_views = paywall_views + 1
       WHERE slug = #{slug} AND status = 'published' AND IFNULL(unlock_price,0) > 0 LIMIT 1
      """)
  int bumpPaywallView(@Param("slug") String slug);

  /* ==================== 站内信读取 ==================== */

  @Select("""
      SELECT id, type, title, body, link, is_read AS isRead,
             DATE_FORMAT(created_at,'%m-%d %H:%i') AS createdAt
        FROM notifications WHERE user_id = #{userId}
       ORDER BY created_at DESC LIMIT 30
      """)
  List<CommunityRows.Notice> notices(@Param("userId") long userId);

  @Select("SELECT COUNT(*) AS unread FROM notifications WHERE user_id = #{userId} AND is_read = 0")
  Long unreadCount(@Param("userId") long userId);

  @Update("UPDATE notifications SET is_read = 1 WHERE id = #{id} AND user_id = #{userId}")
  int markNoticeRead(
      @Param("id") long id, @Param("userId") long userId);

  @Update("UPDATE notifications SET is_read = 1 WHERE user_id = #{userId} AND is_read = 0")
  int markAllRead(@Param("userId") long userId);
}
