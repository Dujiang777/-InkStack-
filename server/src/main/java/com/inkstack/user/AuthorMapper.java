package com.inkstack.user;

import com.inkstack.entity.AuthorProfile;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/** 作者主页的公开档案。三个计数子查询都限定"已发布且过审"，与 Node getAuthor 逐字一致。 */
@Mapper
public interface AuthorMapper {

  @Select("""
      SELECT u.id, u.nickname, u.avatar_text AS avatarText,
             COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
             IFNULL(u.bio,'') AS bio,
             DATE_FORMAT(u.created_at,'%Y-%m-%d') AS createdAt,
             (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id
               AND a.status='published' AND a.review_status='approved') AS articles,
             (SELECT IFNULL(SUM(a.like_count),0) FROM articles a WHERE a.author_id = u.id
               AND a.status='published' AND a.review_status='approved') AS likes,
             (SELECT IFNULL(SUM(a.read_count),0) FROM articles a WHERE a.author_id = u.id
               AND a.status='published' AND a.review_status='approved') AS readTotal
        FROM users u WHERE u.id = #{id} LIMIT 1
      """)
  AuthorProfile profile(@Param("id") long id);
}
