package com.inkstack.mapper;

import com.inkstack.entity.FollowCounts;
import com.inkstack.entity.MeRows;
import com.inkstack.entity.TipRow;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SocialMapper {

  /** 本文最近打赏动态。注意 DATE_FORMAT 用的是 '%m-%d %H:%i'，<b>不含年份</b>——照抄，别"顺手补全"。 */
  @Select("""
      SELECT u.nickname AS fromName, IFNULL(u.avatar_text,'') AS fromAvatar, t.amount,
             DATE_FORMAT(t.created_at, '%m-%d %H:%i') AS createdAt
        FROM article_tips t
        JOIN users u ON u.id = t.from_user
        JOIN articles a ON a.id = t.article_id
       WHERE a.slug = #{slug}
       ORDER BY t.created_at DESC
       LIMIT #{limit}
      """)
  List<TipRow> listArticleTips(@Param("slug") String slug, @Param("limit") int limit);

  @Select("""
      SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = #{userId}) AS followers,
             (SELECT COUNT(*) FROM follows WHERE follower_id = #{userId}) AS following
      """)
  FollowCounts followCounts(@Param("userId") long userId);

  @Select("SELECT 1 FROM follows WHERE follower_id = #{followerId} AND followee_id = #{followeeId} LIMIT 1")
  Integer existsFollow(@Param("followerId") long followerId, @Param("followeeId") long followeeId);

  @Select("""
      SELECT b.id FROM bookmarks b JOIN articles a ON a.id = b.article_id
       WHERE b.user_id = #{userId} AND a.slug = #{slug} LIMIT 1
      """)
  Integer existsBookmark(@Param("userId") long userId, @Param("slug") String slug);

  /* ---------- 个人中心足迹（Node 里是六个独立函数，这里一一对位） ---------- */

  @Select("""
      SELECT u.id, u.nickname, u.avatar_text AS avatarText,
             COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
             IFNULL(u.bio, '') AS bio,
             (SELECT COUNT(*) FROM articles a
               WHERE a.author_id = u.id AND a.status = 'published' AND a.review_status = 'approved') AS articles
        FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = #{userId}
       ORDER BY f.created_at DESC LIMIT #{limit}
      """)
  List<MeRows.Peer> followers(@Param("userId") long userId, @Param("limit") int limit);

  /** 与 followers 只差 join 目标与 WHERE 方向，刻意写成两条而不是一个开关：读的人不必在脑中展开条件。 */
  @Select("""
      SELECT u.id, u.nickname, u.avatar_text AS avatarText,
             COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
             IFNULL(u.bio, '') AS bio,
             (SELECT COUNT(*) FROM articles a
               WHERE a.author_id = u.id AND a.status = 'published' AND a.review_status = 'approved') AS articles
        FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = #{userId}
       ORDER BY f.created_at DESC LIMIT #{limit}
      """)
  List<MeRows.Peer> following(@Param("userId") long userId, @Param("limit") int limit);

  /**
   * 我赞过的文章。注意这里<b>没有</b> review_status='approved' 条件（Node 同样没有）：
   * 待审文章仍会出现在自己的足迹里。移植时不要"顺手补全"，那是改语义。
   */
  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, a.read_count AS readCount
        FROM article_likes l
        JOIN articles a ON a.id = l.article_id
        JOIN users u ON u.id = a.author_id
       WHERE l.user_id = #{userId} AND a.status = 'published'
       ORDER BY l.created_at DESC LIMIT #{limit}
      """)
  List<MeRows.Footprint> myLikes(@Param("userId") long userId, @Param("limit") int limit);

  @Select("""
      SELECT c.id, c.content,
             DATE_FORMAT(c.created_at,'%Y-%m-%d') AS createdAt,
             a.slug AS articleSlug, a.title AS articleTitle
        FROM comments c JOIN articles a ON a.id = c.article_id
       WHERE c.user_id = #{userId} AND a.status = 'published'
       ORDER BY c.created_at DESC LIMIT #{limit}
      """)
  List<MeRows.Comment> myComments(@Param("userId") long userId, @Param("limit") int limit);

  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, a.read_count AS readCount,
             DATE_FORMAT(b.created_at,'%Y-%m-%d') AS savedAt
        FROM bookmarks b
        JOIN articles a ON a.id = b.article_id
        JOIN users u ON u.id = a.author_id
       WHERE b.user_id = #{userId} AND a.status = 'published'
       ORDER BY b.created_at DESC LIMIT #{limit}
      """)
  List<MeRows.Footprint> myBookmarks(@Param("userId") long userId, @Param("limit") int limit);

  /** 阅读足迹：readAt 用 '%Y-%m-%d %H:%i'（精确到分，不含秒），与 Node 同格式。 */
  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, a.read_count AS readCount,
             DATE_FORMAT(h.read_at,'%Y-%m-%d %H:%i') AS readAt, h.read_times AS times
        FROM read_history h
        JOIN articles a ON a.id = h.article_id
        JOIN users u ON u.id = a.author_id
       WHERE h.user_id = #{userId} AND a.status = 'published'
       ORDER BY h.read_at DESC LIMIT #{limit}
      """)
  List<MeRows.Footprint> myHistory(@Param("userId") long userId, @Param("limit") int limit);
}
