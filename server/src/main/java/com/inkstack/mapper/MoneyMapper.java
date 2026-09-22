package com.inkstack.mapper;

import com.inkstack.entity.MoneyRows;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Options;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * 墨水经济的写链路语句：单篇解锁、专栏打包、打赏、加热、签到、充值到账。
 *
 * <p>与 {@link UserMapper}（points_balance 的唯一改写入口）和
 * {@link PointLedgerMapper}（流水）配对使用，<b>三者必须落在同一个事务里</b>——
 * 账实相符（余额 == Σ流水 + 注册赠送）没有任何数据库约束兜底，全靠"改一笔余额就补一笔流水"
 * 这个成对纪律。所以每条链路的语句顺序都按 lib/data.ts 原样排布，不要重排、不要合并。
 */
@Mapper
public interface MoneyMapper {

  /* ==================== 单篇解锁（读者付全价，作者得 70%） ==================== */

  /**
   * 解锁前置读。注意 {@code review_status IS NULL} 这一支：Node 原样如此
   * （老数据有过审字段为空的已发布文），补成"必须 approved"会让这类文章解不开。
   */
  @Select("""
      SELECT id, author_id AS authorId, IFNULL(unlock_price,0) AS price,
             IFNULL(discount_price,0) AS dprice, discount_until AS duntil
        FROM articles
       WHERE slug = #{slug} AND status = 'published'
             AND (review_status = 'approved' OR review_status IS NULL) LIMIT 1
      """)
  MoneyRows.PayTarget payTarget(@Param("slug") String slug);

  /**
   * 占位判重：唯一键 (article_id, user_id) 挡并发双击。
   * INSERT IGNORE 的 affectedRows 就是幂等神谕——0 表示"这单早就有了"，
   * 事务随后回滚，价格与分账都不写，所以后面那条 finalizePurchase 才会补真金额。
   */
  @Insert("""
      INSERT IGNORE INTO article_purchases (article_id, user_id, price, author_gain)
       VALUES (#{articleId}, #{userId}, 0, 0)
      """)
  int placePurchase(@Param("articleId") long articleId, @Param("userId") long userId);

  @Update("""
      UPDATE article_purchases SET price = #{price}, author_gain = #{authorGain}
       WHERE article_id = #{articleId} AND user_id = #{userId}
      """)
  int finalizePurchase(
      @Param("price") long price,
      @Param("authorGain") long authorGain,
      @Param("articleId") long articleId,
      @Param("userId") long userId);

  /** 打包链路里的逐篇明细：带金额版，同样是 INSERT IGNORE（已单买过的篇目跳过）。 */
  @Insert("""
      INSERT IGNORE INTO article_purchases (article_id, user_id, price, author_gain)
       VALUES (#{articleId}, #{userId}, #{price}, #{authorGain})
      """)
  int insertPurchasePaid(
      @Param("articleId") long articleId,
      @Param("userId") long userId,
      @Param("price") long price,
      @Param("authorGain") long authorGain);

  /** 解锁成功后给作者发站内信的取数（Node 在路由里重查一次，连 title 一起拿）。 */
  @Select("SELECT a.author_id AS authorId, a.title FROM articles a WHERE a.slug = #{slug} LIMIT 1")
  MoneyRows.ArticleRef articleRef(@Param("slug") String slug);

  /* ==================== 打赏 / 加热（只认已发布，不过问 review_status） ==================== */

  @Select("""
      SELECT id, author_id AS authorId FROM articles
       WHERE slug = #{slug} AND status = 'published' LIMIT 1
      """)
  MoneyRows.ArticleBrief publishedBrief(@Param("slug") String slug);

  @Insert("""
      INSERT INTO article_tips (article_id, from_user, to_user, amount)
       VALUES (#{articleId}, #{fromUser}, #{toUser}, #{amount})
      """)
  int insertTip(
      @Param("articleId") long articleId,
      @Param("fromUser") long fromUser,
      @Param("toUser") long toUser,
      @Param("amount") long amount);

  /**
   * 加热截止的叠加规则：新截止 = MAX(现在, 该文章尚未过期的最晚截止) + 24h。
   * 子查询里那句 {@code boost_until > NOW()} 是"过期不续接"的关键——断了档就从今天重新算。
   */
  @Insert("""
      INSERT INTO article_boosts (article_id, user_id, boost_until)
       VALUES (#{articleId}, #{userId}, DATE_ADD(GREATEST(NOW(), IFNULL(
          (SELECT MAX(b.boost_until) FROM article_boosts b
            WHERE b.article_id = #{articleId} AND b.boost_until > NOW()), NOW())), INTERVAL 24 HOUR))
      """)
  @Options(useGeneratedKeys = true, keyProperty = "id", keyColumn = "id")
  int insertBoost(MoneyRows.Boost boost);

  @Select("SELECT boost_until FROM article_boosts WHERE id = #{id}")
  LocalDateTime boostUntilOf(@Param("id") long id);

  /* ==================== 专栏打包解锁（一口价按篇目快照分摊） ==================== */

  @Select("SELECT id, author_id AS authorId, bundle_price AS bundlePrice FROM series WHERE id = #{id} LIMIT 1")
  MoneyRows.BundleHead bundleHead(@Param("id") long id);

  /**
   * 购买时点的待解锁付费篇目快照。
   *
   * <p>Node 原语句<b>没有 ORDER BY</b>，这里刻意不加：分摊的余数是发给"前几篇"的，
   * 加了排序就改了落库的 price/author_gain 明细。两栈跑同一条语句、同一个执行计划，
   * 顺序才是同源的。
   */
  @Select("""
      SELECT a.id
        FROM series_items si JOIN articles a ON a.id = si.article_id
       WHERE si.series_id = #{seriesId} AND a.status = 'published' AND a.review_status = 'approved'
             AND IFNULL(a.unlock_price,0) > 0
             AND NOT EXISTS(SELECT 1 FROM article_purchases p
                             WHERE p.article_id = a.id AND p.user_id = #{userId})
      """)
  List<Long> pendingPaidArticles(@Param("seriesId") long seriesId, @Param("userId") long userId);

  @Insert("""
      INSERT IGNORE INTO series_purchases (series_id, user_id, price, author_gain, item_count)
       VALUES (#{seriesId}, #{userId}, 0, 0, 0)
      """)
  int placeSeriesPurchase(@Param("seriesId") long seriesId, @Param("userId") long userId);

  @Update("""
      UPDATE series_purchases SET price = #{price}, author_gain = #{authorGain}, item_count = #{itemCount}
       WHERE series_id = #{seriesId} AND user_id = #{userId}
      """)
  int finalizeSeriesPurchase(
      @Param("price") long price,
      @Param("authorGain") long authorGain,
      @Param("itemCount") long itemCount,
      @Param("seriesId") long seriesId,
      @Param("userId") long userId);

  /* ==================== 充值：下单 + 到账 ==================== */

  @Insert("""
      INSERT INTO topup_orders (user_id, order_no, pack_key, amount_cents, points, status)
       VALUES (#{userId}, #{orderNo}, #{packKey}, #{amountCents}, #{points}, 'pending')
      """)
  int insertOrder(
      @Param("userId") long userId,
      @Param("orderNo") String orderNo,
      @Param("packKey") String packKey,
      @Param("amountCents") long amountCents,
      @Param("points") long points);

  /** 到账前置锁：order_no 唯一，但 user_id 同时在 WHERE 里——越权读别人的订单直接判"不存在"。 */
  @Select("""
      SELECT o.pack_key AS packKey, o.points, o.status
        FROM topup_orders o WHERE o.order_no = #{orderNo} AND o.user_id = #{userId} FOR UPDATE
      """)
  MoneyRows.TopupOrder lockOrder(@Param("orderNo") String orderNo, @Param("userId") long userId);

  /** 状态机收口在 WHERE 里：{@code status='pending'} 的 affectedRows 才是真正的幂等锚点。 */
  @Update("""
      UPDATE topup_orders SET status = 'paid', paid_at = NOW(), channel = #{channel}
       WHERE order_no = #{orderNo} AND status = 'pending'
      """)
  int markOrderPaid(@Param("orderNo") String orderNo, @Param("channel") String channel);

  /* ==================== 每日签到 ==================== */

  @Select("SELECT 1 FROM checkins WHERE user_id = #{userId} AND checkin_date = #{day} LIMIT 1")
  Integer checkedInOn(@Param("userId") long userId, @Param("day") LocalDate day);

  /** 连续天数往回数用；limit 分别取 400（签到状态）与 30（成就徽章），与 Node 两个调用点一致。 */
  @Select("""
      SELECT checkin_date FROM checkins WHERE user_id = #{userId}
       ORDER BY checkin_date DESC LIMIT #{limit}
      """)
  List<LocalDate> checkinDates(@Param("userId") long userId, @Param("limit") int limit);

  /** 主键 (user_id, checkin_date) 天然防重放；并发双击时败者抛 DuplicateKey，事务回滚后按"已签"应答。 */
  @Insert("INSERT INTO checkins (user_id, checkin_date) VALUES (#{userId}, #{day})")
  int insertCheckin(@Param("userId") long userId, @Param("day") LocalDate day);
}
