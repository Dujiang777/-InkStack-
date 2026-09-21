package com.inkstack.mapper;

import com.inkstack.entity.CommentRow;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface CommentMapper {

  /**
   * 文章评论区列表。三处易错点：
   * <ul>
   *   <li>父评论作者是 COALESCE(pu.nickname, p.guest_nickname, '楼层')，
   *       因此顶层评论（无父）也会拿到字符串 '楼层' 而不是 null——Node 就是这个形状，照抄；</li>
   *   <li>游客评论没有 user_id，昵称走 guest_nickname，兜底 '访客'；</li>
   *   <li>排序是 created_at <b>升序</b>（正序盖楼），与信息流的重力排序方向相反。</li>
   * </ul>
   */
  @Select("""
      <script>
      SELECT c.id,
             COALESCE(u.nickname, c.guest_nickname, '访客') AS nickname,
             c.content,
             c.parent_id AS parentId,
             COALESCE(pu.nickname, p.guest_nickname, '楼层') AS parentAuthor,
             DATE_FORMAT(c.created_at,'%Y-%m-%d %H:%i') AS createdAt,
             c.user_id AS userId,
             COALESCE(u.avatar_text, '') AS avatarText,
             COALESCE(u.avatar_tone, '') AS avatarTone,
             COALESCE(u.avatar_shape, '') AS avatarShape,
             (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS likes,
             <choose>
               <when test="viewerId != null">
                 EXISTS(SELECT 1 FROM comment_likes v WHERE v.comment_id = c.id AND v.user_id = #{viewerId}) AS viewerLiked
               </when>
               <otherwise>0 AS viewerLiked</otherwise>
             </choose>
        FROM comments c
        JOIN articles a ON a.id = c.article_id
        LEFT JOIN comments p ON p.id = c.parent_id
        LEFT JOIN users pu ON pu.id = p.user_id
        LEFT JOIN users u ON u.id = c.user_id
       WHERE a.slug = #{slug}
       ORDER BY c.created_at ASC LIMIT 300
      </script>
      """)
  List<CommentRow> listByArticleSlug(@Param("slug") String slug, @Param("viewerId") Long viewerId);
}
