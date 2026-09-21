package com.inkstack.mapper;

import com.inkstack.entity.WeeklyCounts;
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
}
