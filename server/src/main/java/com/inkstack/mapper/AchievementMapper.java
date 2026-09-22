package com.inkstack.mapper;

import com.inkstack.entity.MoneyRows;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * 成就墙的计数读数。Node 的 listAchievements 用 Promise.all 发八句，这里合成一句
 * （同 {@link SocialMapper#followCounts} 的写法）：徽章判定只看"够不够数"，
 * 八句与一句在同一时点读到的数是一样的。
 *
 * <p>刻意<b>不</b>复用 {@code ArticleMapper} 的看板查询：那几个函数带 status/review 的可选条件，
 * 而徽章的口径是硬编码的"已发布且过审"，合在一起改一处就悄悄改了成就判定。
 */
@Mapper
public interface AchievementMapper {

  @Select("""
      SELECT
        (SELECT COUNT(*) FROM articles WHERE author_id = #{userId}
              AND status = 'published' AND review_status = 'approved') AS `articles`,
        (SELECT IFNULL(SUM(read_count),0) FROM articles WHERE author_id = #{userId}
              AND status = 'published' AND review_status = 'approved') AS `reads`,
        (SELECT IFNULL(SUM(a.like_count),0) FROM articles a WHERE a.author_id = #{userId}
              AND a.status = 'published' AND a.review_status = 'approved') AS `likes`,
        (SELECT IFNULL(SUM(a.comment_count),0) FROM articles a WHERE a.author_id = #{userId}
              AND a.status = 'published' AND a.review_status = 'approved') AS `comments`,
        (SELECT points_balance FROM users WHERE id = #{userId}) AS `balance`,
        (SELECT COUNT(*) FROM follows WHERE follower_id = #{userId}) AS `following`,
        (SELECT COUNT(*) FROM follows WHERE followee_id = #{userId}) AS `fans`,
        (SELECT COUNT(*) FROM agent_qa WHERE asker_id = #{userId}) AS `qa`
      """)
  MoneyRows.Badges badges(@Param("userId") long userId);
}
