package com.inkstack.money;

import com.inkstack.common.NodeShapes;
import com.inkstack.common.Pricing;
import com.inkstack.entity.MoneyRows;
import com.inkstack.mapper.MoneyMapper;
import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.UserMapper;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 墨水经济的四条资金写链路：单篇解锁、专栏打包、打赏、加热。
 *
 * <p><b>事务边界就是钱的边界</b>，所以这里用 {@link TransactionTemplate} 显式开合，
 * 而不给方法挂 {@code @Transactional}：Node 侧那四条链路都是"前置读走自动提交的池连接、
 * 真正的动钱才 BEGIN"，注解式事务会把前置读也圈进事务里，快照起点随之提前——
 * 双轨期最不该出现的就是这种"看起来一样、锁的时点不一样"的差。
 *
 * <p>三条不变量，每条链路的写法都受它们约束：
 * <ol>
 *   <li><b>占位先行</b>：先 {@code INSERT IGNORE} 一条唯一键记录，用它的 affectedRows 判重，
 *       挡掉并发双击；金额为 0 的占位行在链路末尾被补齐真值。</li>
 *   <li><b>改余额必配流水</b>：{@code users.points_balance} 与 {@code point_ledger} 成对相邻，
 *       账实相符没有数据库约束兜底，全靠这条纪律。</li>
 *   <li><b>多把锁按主键升序</b>：涉及双方账户时一条语句锁两行（见 {@link UserMapper#lockPair}），
 *       避免互打赏交叉等待。</li>
 * </ol>
 */
@Service
public class MoneyService {

  /** 打赏档位：只此两档，档位之外的入参一律拒（Node 的 TIP_AMOUNTS）。 */
  public static final List<Long> TIP_AMOUNTS = List.of(10L, 50L);
  /** 加热一次 80 滴墨，买 24 小时信息流加权。 */
  public static final long BOOST_COST = 80L;

  public static final String REASON_UNLOCK = "付费解锁文章";
  public static final String REASON_UNLOCKED = "文章被解锁";
  public static final String REASON_BUNDLE = "专栏打包解锁";
  public static final String REASON_BUNDLED = "专栏被打包解锁";
  public static final String REASON_TIP = "墨水打赏";
  public static final String REASON_TIPPED = "收到打赏";
  public static final String REASON_BOOST = "文章加热·24h";

  /** 与 Node 的 MoneyFailCode 同集：路由按它映射状态码，打赏/加热用 403、其余用 400。 */
  public enum Fail {
    NOTFOUND,
    FORBIDDEN,
    INSUFFICIENT,
    SERVER
  }

  /** 解锁结果。Node 的 UnlockResult 不带 code，状态码由 error 的子串决定——照搬，别顺手补 code。 */
  public record UnlockResult(boolean ok, String error, long price, long authorGot, long balance) {

    static UnlockResult fail(String error) {
      return new UnlockResult(false, error, 0, 0, 0);
    }

    /** 已解锁过：ok=true 且 price=0，balance=-1 是 Node 原样的"未动账"占位，不外露。 */
    static UnlockResult already() {
      return new UnlockResult(true, null, 0, 0, -1);
    }

    static UnlockResult paid(long price, long authorGot, long balance) {
      return new UnlockResult(true, null, price, authorGot, balance);
    }
  }

  public record BundleResult(
      boolean ok, String error, Fail code,
      long price, long authorGot, long unlocked, long balance, boolean already) {

    static BundleResult fail(String error, Fail code) {
      return new BundleResult(false, error, code, 0, 0, 0, 0, false);
    }

    static BundleResult alreadyBought() {
      return new BundleResult(true, null, null, 0, 0, 0, -1, true);
    }

    static BundleResult paid(long price, long authorGot, long unlocked, long balance) {
      return new BundleResult(true, null, null, price, authorGot, unlocked, balance, false);
    }
  }

  public record TipResult(
      boolean ok, String error, Fail code, long amount, long authorGot, long balance, long toUserId) {

    static TipResult fail(String error, Fail code) {
      return new TipResult(false, error, code, 0, 0, 0, 0);
    }

    static TipResult paid(long amount, long authorGot, long balance, long toUserId) {
      return new TipResult(true, null, null, amount, authorGot, balance, toUserId);
    }
  }

  /** boostUntil 已是 UTC ISO 串：出网格式在 Service 里定死，Controller 不再碰时间。 */
  public record BoostResult(
      boolean ok, String error, Fail code, long cost, long balance, String boostUntil) {

    static BoostResult fail(String error, Fail code) {
      return new BoostResult(false, error, code, 0, 0, null);
    }

    static BoostResult paid(long balance, String boostUntil) {
      return new BoostResult(true, null, null, BOOST_COST, balance, boostUntil);
    }
  }

  private final MoneyMapper money;
  private final UserMapper users;
  private final PointLedgerMapper ledger;
  private final TransactionTemplate tx;

  public MoneyService(MoneyMapper money, UserMapper users, PointLedgerMapper ledger, TransactionTemplate tx) {
    this.money = money;
    this.users = users;
    this.ledger = ledger;
    this.tx = tx;
  }

  public static String tipTierError() {
    return "打赏档位须为 "
        + TIP_AMOUNTS.stream().map(String::valueOf).collect(Collectors.joining(" 或 ")) + " 点墨";
  }

  /**
   * 档位判定按 JS 的 {@code [10,50].includes(Number(body.amount))} 来：所以
   * {@code "10"}（字符串）与 {@code 1e1} 都算合法，而 {@code 10.5} 不算——
   * 收 double 而不是 long 就是为了不在解析阶段悄悄把 10.5 截成 10。
   */
  public static boolean isTipTier(double amount) {
    return TIP_AMOUNTS.stream().anyMatch(v -> v.doubleValue() == amount);
  }

  private static String shortFall(long balance, long need) {
    return "积分不足（余额 " + balance + "，本次需 " + need + "）";
  }

  /**
   * 解锁一篇付费文章：读者付生效价（早鸟到点自动回原价），作者得 70%，平台留 30%。
   *
   * <p>"已买过"不是错误：占位 INSERT IGNORE 打回 0 行时按成功返回 price=0，
   * 让前端把"已解锁"当正常态渲染，同时不产生任何账务。
   */
  public UnlockResult unlock(String slug, long userId) {
    MoneyRows.PayTarget art = money.payTarget(slug);
    if (art == null) {
      return UnlockResult.fail("文章不存在或未公开");
    }
    long price = Pricing.unlockPrice(NodeShapes.num(art.getPrice()),
        NodeShapes.num(art.getDprice()), art.getDuntil());
    // 免费判定看的是原价：折扣只在原价>0 时才有意义，用生效价判会放过 0 元折扣
    if (NodeShapes.num(art.getPrice()) <= 0) {
      return UnlockResult.fail("本文免费，无需解锁");
    }
    if (art.getAuthorId().longValue() == userId) {
      return UnlockResult.fail("作者本人无需解锁");
    }
    final long articleId = art.getId();
    final long authorId = art.getAuthorId();
    try {
      return tx.execute(status -> {
        if (money.placePurchase(articleId, userId) == 0) {
          status.setRollbackOnly();
          return UnlockResult.already();
        }
        long bal = NodeShapes.num(users.lockBalance(userId));
        if (bal < price) {
          status.setRollbackOnly();
          return UnlockResult.fail(shortFall(bal, price));
        }
        users.spend(userId, price);
        ledger.insert(userId, -price, REASON_UNLOCK);
        long authorGot = Pricing.authorShare(price, Pricing.UNLOCK_SHARE);
        users.credit(authorId, authorGot);
        ledger.insert(authorId, authorGot, REASON_UNLOCKED);
        money.finalizePurchase(price, authorGot, articleId, userId);
        return UnlockResult.paid(price, authorGot, bal - price);
      });
    } catch (RuntimeException failed) {
      return UnlockResult.fail("解锁失败，请稍后再试");
    }
  }

  /**
   * 打包购买整个专栏：一口价买断"购买时点"的待解锁付费篇目快照。
   *
   * <p>分摊用 floor 均摊、余数发给前几篇，使 Σshares 恒等于打包价；每篇再按 70/30 落
   * article_purchases 明细，因此书房收入看板天然兼容打包订单。已打包购买过则按快照语义
   * 返回 already（不为新篇目补账）。
   */
  public BundleResult bundle(long seriesId, long userId) {
    MoneyRows.BundleHead head = money.bundleHead(seriesId);
    if (head == null) {
      return BundleResult.fail("专栏不存在", Fail.NOTFOUND);
    }
    final long bundlePrice = NodeShapes.num(head.getBundlePrice());
    if (bundlePrice <= 0) {
      return BundleResult.fail("本专栏未开放打包购买", Fail.FORBIDDEN);
    }
    if (head.getAuthorId().longValue() == userId) {
      return BundleResult.fail("这是你自己的专栏，无需购买", Fail.FORBIDDEN);
    }
    List<Long> pending = money.pendingPaidArticles(seriesId, userId);
    if (pending.isEmpty()) {
      return BundleResult.fail("专栏内已无待解锁的付费篇目", Fail.FORBIDDEN);
    }
    // floor 均摊，余数逐篇发给前几篇：保证 Σshares == bundlePrice，一分都不多不少。
    // 明细按什么顺序分摊取决于 pending 的返回顺序（Node 无 ORDER BY，见 MoneyMapper 的说明），
    // 所以这里不排序、也不把余数"聪明地"发给高价篇。
    int count = pending.size();
    long base = bundlePrice / count;
    long remainder = bundlePrice - base * count;
    List<Long> shares = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      shares.add(base + (i < remainder ? 1 : 0));
    }
    List<Long> gains = new ArrayList<>(count);
    long authorGot = 0;
    for (Long share : shares) {
      long gain = Pricing.authorShare(share, Pricing.BUNDLE_SHARE);
      gains.add(gain);
      authorGot += gain;
    }
    final long authorId = head.getAuthorId();
    final long authorGain = authorGot;
    try {
      return tx.execute(status -> {
        if (money.placeSeriesPurchase(seriesId, userId) == 0) {
          status.setRollbackOnly();
          return BundleResult.alreadyBought();
        }
        long bal = NodeShapes.num(users.lockBalance(userId));
        if (bal < bundlePrice) {
          status.setRollbackOnly();
          return BundleResult.fail(shortFall(bal, bundlePrice), Fail.INSUFFICIENT);
        }
        users.spend(userId, bundlePrice);
        ledger.insert(userId, -bundlePrice, REASON_BUNDLE);
        users.credit(authorId, authorGain);
        ledger.insert(authorId, authorGain, REASON_BUNDLED);
        for (int i = 0; i < count; i++) {
          money.insertPurchasePaid(pending.get(i), userId, shares.get(i), gains.get(i));
        }
        money.finalizeSeriesPurchase(bundlePrice, authorGain, count, seriesId, userId);
        return BundleResult.paid(bundlePrice, authorGain, count, bal - bundlePrice);
      });
    } catch (RuntimeException failed) {
      return BundleResult.fail("打包解锁失败，请稍后再试", Fail.SERVER);
    }
  }

  /**
   * 打赏：读者扣全额、作者得 90%，双份流水与 article_tips 明细同事务。
   *
   * <p>Node 在 v17.3 之前是"扣款事务 + 入账事务 + 失败补偿"的两段式，补偿自身再失败就永久丢墨；
   * 现在一条链一次提交，Java 照抄这个形状。<b>不要</b>把它拆回两个事务。
   */
  public TipResult tip(String slug, long fromUserId, long amount) {
    if (!TIP_AMOUNTS.contains(amount)) {
      return TipResult.fail(tipTierError(), Fail.SERVER);
    }
    MoneyRows.ArticleBrief art = money.publishedBrief(slug);
    if (art == null) {
      return TipResult.fail("文章不存在", Fail.NOTFOUND);
    }
    final long articleId = art.getId();
    final long toUserId = art.getAuthorId();
    if (toUserId == fromUserId) {
      return TipResult.fail("不能给自己的文章打赏", Fail.FORBIDDEN);
    }
    final long authorGot = Pricing.authorShare(amount, Pricing.TIP_SHARE);
    try {
      return tx.execute(status -> {
        long bal = balanceOf(users.lockPair(fromUserId, toUserId), fromUserId);
        if (bal < amount) {
          status.setRollbackOnly();
          return TipResult.fail(shortFall(bal, amount), Fail.INSUFFICIENT);
        }
        users.spend(fromUserId, amount);
        ledger.insert(fromUserId, -amount, REASON_TIP);
        users.credit(toUserId, authorGot);
        ledger.insert(toUserId, authorGot, REASON_TIPPED);
        money.insertTip(articleId, fromUserId, toUserId, amount);
        return TipResult.paid(amount, authorGot, bal - amount, toUserId);
      });
    } catch (RuntimeException failed) {
      return TipResult.fail("打赏失败，请稍后再试", Fail.SERVER);
    }
  }

  /**
   * 加热自己的文章：80 滴墨换 24 小时加权，可叠加（新截止从"未过期的最晚截止"往后接）。
   *
   * <p>insertId 拿不到就整体回滚——那 80 点墨要么换来一条加热记录，要么一分不动，
   * 不存在 Node 老实现里"钱扣了、写库抛异常、既不加热也不退"的第三种结局。
   */
  public BoostResult boost(String slug, long userId) {
    MoneyRows.ArticleBrief art = money.publishedBrief(slug);
    if (art == null) {
      return BoostResult.fail("文章不存在", Fail.NOTFOUND);
    }
    if (art.getAuthorId().longValue() != userId) {
      return BoostResult.fail("只能加热自己的文章", Fail.FORBIDDEN);
    }
    final long articleId = art.getId();
    try {
      return tx.execute(status -> {
        long bal = NodeShapes.num(users.lockBalance(userId));
        if (bal < BOOST_COST) {
          status.setRollbackOnly();
          return BoostResult.fail(shortFall(bal, BOOST_COST), Fail.INSUFFICIENT);
        }
        users.spend(userId, BOOST_COST);
        ledger.insert(userId, -BOOST_COST, REASON_BOOST);
        MoneyRows.Boost row = new MoneyRows.Boost();
        row.setArticleId(articleId);
        row.setUserId(userId);
        money.insertBoost(row);
        long boostId = NodeShapes.num(row.getId());
        if (boostId == 0) {
          status.setRollbackOnly();
          return BoostResult.fail("加热失败，请稍后再试", Fail.SERVER);
        }
        LocalDateTime until = money.boostUntilOf(boostId);
        return BoostResult.paid(bal - BOOST_COST, NodeShapes.iso(until));
      });
    } catch (RuntimeException failed) {
      return BoostResult.fail("加热失败，请稍后再试", Fail.SERVER);
    }
  }

  /** 双行锁结果里取自己那行的余额；查不到按 0（Node 的 {@code ?.points_balance ?? 0} 同语义）。 */
  private static long balanceOf(List<MoneyRows.Balance> rows, long uid) {
    return rows.stream()
        .filter(r -> r.getId() != null && r.getId().longValue() == uid)
        .map(MoneyRows.Balance::getPointsBalance)
        .filter(Objects::nonNull)
        .findFirst()
        .map(Long::longValue)
        .orElse(0L);
  }
}
