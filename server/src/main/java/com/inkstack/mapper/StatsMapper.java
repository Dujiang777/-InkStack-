package com.inkstack.mapper;

import com.inkstack.entity.StatRows;
import com.inkstack.entity.WeeklyCounts;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface StatsMapper {

  /**
   * 每周墨报的本期计数。{@code from} 是 Node 侧算好的 'YYYY-MM-DD'（周报的边界由 JS 的
   * ISO 周算法决定，不在这里重新发明，否则两栈的"本期"会差一天）。
   *
   * <p>文章口径用 {@code review_status IS NULL OR = 'approved'}——老库存在没有审核字段的行，
   * 只写 = 'approved' 会把它们漏掉，Node 就是这么兜的。
   */
  @Select("""
      SELECT
        (SELECT COUNT(*) FROM articles
          WHERE status='published' AND (review_status IS NULL OR review_status='approved')
            AND published_at >= #{from}) AS newArticles,
        (SELECT COUNT(*) FROM users WHERE created_at >= #{from}) AS newUsers,
        (SELECT COUNT(*) FROM comments WHERE created_at >= #{from}) AS newComments,
        (SELECT COUNT(*) FROM series WHERE created_at >= #{from}) AS newSeries,
        (SELECT COUNT(*) FROM article_tips WHERE created_at >= #{from}) AS tipCount,
        (SELECT IFNULL(SUM(amount),0) FROM article_tips WHERE created_at >= #{from}) AS tipInk
      """)
  WeeklyCounts weeklySince(@Param("from") String from);

  /**
   * 首页数据横幅的四个全站计数。逐字照 Node 的 platformStats 搬，包括两处**看着像笔误**的地方：
   * <ul>
   *   <li>{@code articles} 用 {@code review_status = 'approved'}，不像 {@link #weeklySince}
   *       那样兜 {@code IS NULL}。老库里没审核字段的行因此不计入首页文章数、却计入周报——
   *       这是既有的展示口径，不是 bug，"顺手统一"会让两个数字在同一天对不上。</li>
   *   <li>{@code authors} 只按 {@code status='published'}，不看审核状态：作者数与文章数不同条件。</li>
   * </ul>
   */
  @Select("""
      SELECT
        (SELECT COUNT(*) FROM articles WHERE status = 'published' AND review_status = 'approved') AS articles,
        (SELECT COUNT(DISTINCT author_id) FROM articles WHERE status = 'published') AS authors,
        (SELECT COUNT(*) FROM agent_qa) AS qaTotal,
        (SELECT IFNULL(SUM(amount),0) FROM article_tips) AS tipsTotal
      """)
  StatRows.Platform platformStats();

  /**
   * 首页作者榜。排序键 {@code likes DESC, readTotal DESC} 用的是 SQL 别名——MySQL 允许，
   * 而 Node 原句就是这么写的，别名换不成表达式（那样 NULL 的处理会不同）。
   * GROUP BY 带上 u 的全部选出列，是为了在 ONLY_FULL_GROUP_BY 下与 Node 的行为一致。
   */
  @Select("""
      SELECT u.id, u.nickname, u.avatar_text AS avatarText,
             COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
             IFNULL(SUM(a.like_count),0) AS likes,
             COUNT(a.id) AS articles,
             IFNULL(SUM(a.read_count),0) AS readTotal
        FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
       GROUP BY a.author_id, u.id, u.nickname, u.avatar_text, u.avatar_tone, u.avatar_shape
       ORDER BY likes DESC, readTotal DESC
       LIMIT #{limit}
      """)
  List<StatRows.AuthorRank> topAuthors(@Param("limit") int limit);
}
