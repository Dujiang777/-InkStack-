package com.inkstack.mapper;

import com.inkstack.entity.AdminRows;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * 运营台的读侧（P7f-1e）：八张表的列表与大盘聚合。
 *
 * <p>刻意与 {@link AdminMapper}（写侧）分文件：写侧那些语句带 {@code ${sql}} 拼接与 FOR UPDATE，
 * 混在一起之后"这条读会不会顺带回一把锁"就没人说得清了。
 *
 * <p>每一条都逐字照 {@code lib/data.ts} 里迁过来的那句搬，包括三处**看着像笔误**的地方：
 * <ul>
 *   <li>内容管理的 {@code reviewStatus} 为 NULL 时展示成 approved（老库没有审核字段的行按过审算），
 *       而首页 {@code platformStats} 那句偏偏不兜 NULL——两句口径不同是既成事实，不是待统一的债。</li>
 *   <li>资金流水的套餐名子查询只列了 <b>三</b> 档，第四档 {@code studio} 不在里面，
 *       于是那一档的订单显示的是 `pack_key` 原文。补齐它会让历史数据"看起来变了"，所以照搬。</li>
 *   <li>审计日志的 LIMIT 在 Node 是字符串插值（{@code Number(limit) || 30}），
 *       这里改成绑定参数——行为相同（非法值同样落成 30），但不再把用户输入拼进语句。</li>
 * </ul>
 */
@Mapper
public interface AdminReadMapper {

  /** 内容管理：全站最近 100 篇，按更新时间倒序。 */
  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, a.status, a.review_status AS reviewStatus,
             a.pinned, a.featured,
             a.read_count AS readCount, a.comment_count AS commentCount,
             IFNULL(a.unlock_price, 0) AS unlockPrice,
             DATE_FORMAT(a.published_at, '%Y-%m-%d') AS publishedAt
        FROM articles a JOIN users u ON u.id = a.author_id
       ORDER BY a.updated_at DESC LIMIT 100
      """)
  List<AdminRows.Article> articles();

  /** 审核队列：待审且已发布（先提交先看），最早优先，最多 50。 */
  @Select("""
      SELECT a.slug, a.title, u.nickname AS author, a.summary,
             DATE_FORMAT(a.updated_at, '%m-%d %H:%i') AS submittedAt
        FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.review_status = 'pending' AND a.status = 'published'
       ORDER BY a.updated_at ASC LIMIT 50
      """)
  List<AdminRows.ReviewItem> reviewQueue();

  /**
   * 用户管理：q 为空时那句 {@code #{like} = '%%'} 恒真——这是 Node 用来"不加过滤"的写法，
   * 不能改成 {@code <if>} 省掉，因为 q 只有空白时 trim 完也是空串，两条分支要落在一起。
   */
  @Select("""
      SELECT u.id, u.nickname, u.email, u.role, u.banned, u.points_balance AS points,
             (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id) AS articleCount,
             DATE_FORMAT(u.created_at, '%Y-%m-%d') AS createdAt
        FROM users u
       WHERE #{like} = '%%' OR u.nickname LIKE #{like} OR u.email LIKE #{like}
       ORDER BY u.id ASC LIMIT 200
      """)
  List<AdminRows.UserRow> users(@Param("like") String like);

  /** 举报队列：status 为 null 时不加 WHERE（缺省回全部，运营台的"全部"标签靠这个）。 */
  @Select("""
      <script>
      SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.status,
             COALESCE(ru.nickname, '游客') AS reporter,
             CASE r.target_type
               WHEN 'article' THEN (SELECT a.title FROM articles a WHERE a.id = r.target_id)
               ELSE (SELECT CONCAT('评论：', LEFT(c.content, 40)) FROM comments c WHERE c.id = r.target_id)
             END AS targetTitle,
             DATE_FORMAT(r.created_at, '%m-%d %H:%i') AS createdAt
        FROM reports r
        LEFT JOIN users ru ON ru.id = r.reporter_id
        <if test="status != null">WHERE r.status = #{status}</if>
       ORDER BY r.created_at DESC LIMIT 100
      </script>
      """)
  List<AdminRows.ReportItem> reports(@Param("status") String status);

  /** 最近管理操作审计。 */
  @Select("""
      SELECT g.id, COALESCE(u.nickname, '未知') AS admin, g.action,
             g.target_type AS targetType, g.target_id AS targetId, g.detail,
             DATE_FORMAT(g.created_at, '%m-%d %H:%i') AS createdAt
        FROM admin_actions g LEFT JOIN users u ON u.id = g.admin_id
       ORDER BY g.created_at DESC LIMIT #{limit}
      """)
  List<AdminRows.ActionLog> actions(@Param("limit") int limit);

  /**
   * 资金流水：充值 / 单篇解锁 / 专栏打包三段 UNION 后整体按时间倒序取 60。
   *
   * <p><b>这里的 {@code COLLATE utf8mb4_unicode_ci} 不是风格问题，而是这条语句能不能跑。</b>
   * 库里 {@code users}/{@code articles}/{@code series} 是 {@code unicode_ci} 而建，
   * {@code topup_orders} 却是 {@code 0900_ai_ci}（历史遗留，两张表不同年代建的），
   * UNION 要求各列的排序规则可合并，于是这句在 MySQL 层面直接报
   * {@code ER_CANT_AGGREGATE_NCOLLATIONS}。字面量（{@code '充值'}）与派生表 {@code p.name}
   * 的排序规则跟**会话**走，而会话由驱动决定——mysql2 是 unicode_ci、Connector/J 不给
   * {@code connectionCollation} 就跟服务器默认走 0900。所以必须显式钉住，两种会话下都跑得通；
   * 只钉 {@code o.pack_key} 是不够的（另一种会话下会换成 {@code p.name} 撞车）。
   *
   * <p>顺带把一处**既有的隐性 bug 修掉**：Node 那份 {@code adminListOrders} 整段包在
   * {@code try { … } catch { return []; }} 里，于是这句在主库与克隆库上一直失败、
   * 运营台的"资金流水"面板**永远是空表**，而页面看起来一切正常。迁移要求"逐字照搬"在这里
   * 撞到了一条原则：照搬就是把一个恒空的读原样搬进新栈。选择是修，并在此留痕——
   * 判据见闸门 19 的"资金流水"那段（它现在能数出行来，就是证明）。
   *
   * <p>另外 {@code ORDER BY createdAt} 排的是 {@code '%m-%d %H:%i'} 的**成品串**，不含年份，
   * 跨年时顺序会按月-日字典序错排。这是既有展示口径，改它等于重排历史流水，所以照搬并在此记下。
   */
  @Select("""
      (SELECT '充值' COLLATE utf8mb4_unicode_ci AS kind, u.nickname AS user,
              IFNULL(p.name, o.pack_key) COLLATE utf8mb4_unicode_ci AS title,
              o.points AS amount, 0 AS gain,
              DATE_FORMAT(o.paid_at, '%m-%d %H:%i') AS createdAt
         FROM topup_orders o JOIN users u ON u.id = o.user_id
         LEFT JOIN (SELECT 'starter' AS k, '体验包' AS name UNION ALL
                    SELECT 'standard', '标准包' UNION ALL
                    SELECT 'pro', '创作包') p ON p.k = o.pack_key
        WHERE o.status = 'paid')
      UNION ALL
      (SELECT '单篇解锁' COLLATE utf8mb4_unicode_ci, u.nickname, a.title, ap.price, ap.author_gain,
              DATE_FORMAT(ap.created_at, '%m-%d %H:%i')
         FROM article_purchases ap JOIN users u ON u.id = ap.user_id
         JOIN articles a ON a.id = ap.article_id)
      UNION ALL
      (SELECT '专栏打包' COLLATE utf8mb4_unicode_ci, u.nickname, s.title, sp.price, sp.author_gain,
              DATE_FORMAT(sp.created_at, '%m-%d %H:%i')
         FROM series_purchases sp JOIN users u ON u.id = sp.user_id
         JOIN series s ON s.id = sp.series_id)
      ORDER BY createdAt DESC LIMIT 60
      """)
  List<AdminRows.Order> orders();

  /** 评论管理：最近 60 条，正文截 120 字，游客评论落回 guest_nickname。 */
  @Select("""
      SELECT c.id, IFNULL(u.nickname, IFNULL(c.guest_nickname, '旅人')) AS author,
             a.slug AS articleSlug, a.title AS articleTitle,
             LEFT(c.content, 120) AS content,
             DATE_FORMAT(c.created_at, '%m-%d %H:%i') AS createdAt
        FROM comments c
        LEFT JOIN users u ON u.id = c.user_id
        JOIN articles a ON a.id = c.article_id
       ORDER BY c.created_at DESC LIMIT 60
      """)
  List<AdminRows.CommentItem> comments();

  /**
   * 大盘趋势的三条轴：发文 / 注册 / 评论。
   *
   * <p>写三句而不是 {@code ${table}} 拼一张表名：表名进不了绑定参数，一旦开插值口子，
   * 这条语句就能被指向任意有 created_at 列的表，而调用方只有这一个服务——收益是少两行，
   * 代价是一道"看起来内部可信、实际全靠约定"的注入面。
   */
  @Select("""
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS c
        FROM articles
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL #{back} DAY)
       GROUP BY d
      """)
  List<AdminRows.DayCount> dailyArticles(@Param("back") int back);

  @Select("""
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS c
        FROM users
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL #{back} DAY)
       GROUP BY d
      """)
  List<AdminRows.DayCount> dailyUsers(@Param("back") int back);

  @Select("""
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS c
        FROM comments
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL #{back} DAY)
       GROUP BY d
      """)
  List<AdminRows.DayCount> dailyComments(@Param("back") int back);

  /** 大盘的墨水经济五项计数。 */
  @Select("""
      SELECT (SELECT COUNT(*) FROM article_tips) AS tipCount,
             (SELECT IFNULL(SUM(amount), 0) FROM article_tips) AS tipTotal,
             (SELECT COUNT(*) FROM topup_orders WHERE status = 'paid') AS topupCount,
             (SELECT IFNULL(SUM(points), 0) FROM topup_orders WHERE status = 'paid') AS topupTotal,
             (SELECT COUNT(*) FROM agent_qa) AS qaCount
      """)
  AdminRows.Ink ink();

  /** 大盘热门榜：按阅读数取前 5，作者为空展示"佚名"。 */
  @Select("""
      SELECT a.slug, a.title, IFNULL(u.nickname, '佚名') AS author,
             a.read_count AS readCount, a.like_count AS likeCount,
             IFNULL((SELECT SUM(amount) FROM article_tips t WHERE t.article_id = a.id), 0) AS tipTotal
        FROM articles a LEFT JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
       ORDER BY a.read_count DESC LIMIT 5
      """)
  List<AdminRows.TopArticle> topArticles();

  /** 标签构成的原料：全站已过审文章的 tags 列原文，计数留给 Java 侧（下推到 SQL 会改变并列顺序）。 */
  @Select("""
      SELECT tags FROM articles
       WHERE status = 'published' AND review_status = 'approved' AND tags IS NOT NULL
      """)
  List<String> allTags();

  /** 全站付费转化漏斗。series_purchases 缺表时这一句会抛，调用方按 Node 的口径降级成空漏斗。 */
  @Select("""
      SELECT (SELECT COUNT(*) FROM articles WHERE status = 'published' AND review_status = 'approved'
                AND IFNULL(unlock_price, 0) > 0) AS paidArticles,
             (SELECT IFNULL(SUM(IFNULL(paywall_views, 0)), 0) FROM articles
                WHERE IFNULL(unlock_price, 0) > 0 AND status <> 'deleted') AS paywallViews,
             (SELECT COUNT(*) FROM article_purchases) AS unlocks,
             (SELECT IFNULL(SUM(price), 0) FROM article_purchases) AS unlockRevenue,
             (SELECT COUNT(*) FROM series_purchases) AS bundles,
             (SELECT IFNULL(SUM(price), 0) FROM series_purchases) AS bundleRevenue
      """)
  AdminRows.FunnelRow funnel();
}
