package com.inkstack.mapper;

import com.inkstack.entity.FollowCounts;
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
}
