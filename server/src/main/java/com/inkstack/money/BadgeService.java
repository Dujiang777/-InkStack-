package com.inkstack.money;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.MoneyRows;
import com.inkstack.mapper.AchievementMapper;
import com.inkstack.mapper.MoneyMapper;
import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.UserMapper;
import java.time.LocalDate;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 集齐成就徽章的一次性领取（100 滴墨）。
 *
 * <p>这里只算"够不够数"，不复刻整面成就墙：领取链路的判定只看
 * {@code earned === total}，墙上的进度文案仍由 Node 的 listAchievements 供（P7 再收）。
 *
 * <p>判重不靠标记列，靠的是"有没有一条 reason=集齐徽章奖励 的流水"——
 * 所以 {@link #REASON} 是业务键，改一个字就等于给全站用户重开一次领取。
 */
@Service
public class BadgeService {

  private static final Logger log = LoggerFactory.getLogger(BadgeService.class);

  public static final String REASON = "集齐徽章奖励";
  public static final long AMOUNT = 100L;
  /** 连签徽章回看 30 天，与 Node 的 LIMIT 30 同窗口。 */
  private static final int STREAK_WINDOW = 30;

  public enum Outcome {
    /** 还没集齐 */
    MISSING,
    /** 已经领过 */
    CLAIMED,
    /** 发放失败 */
    FAILED,
    /** 刚领到 */
    GRANTED
  }

  public record Claim(Outcome outcome, long missing, long balance, int total) {

    static Claim missing(int total, int earned) {
      return new Claim(Outcome.MISSING, (long) total - earned, 0, total);
    }
  }

  private final AchievementMapper achievements;
  private final MoneyMapper money;
  private final UserMapper users;
  private final PointLedgerMapper ledger;
  private final TransactionTemplate tx;

  public BadgeService(AchievementMapper achievements, MoneyMapper money, UserMapper users,
      PointLedgerMapper ledger, TransactionTemplate tx) {
    this.achievements = achievements;
    this.money = money;
    this.users = users;
    this.ledger = ledger;
    this.tx = tx;
  }

  public Claim claim(long uid) {
    Progress progress = progress(uid);
    if (progress.total() == 0 || progress.earned() < progress.total()) {
      return Claim.missing(progress.total(), progress.earned());
    }
    try {
      Claim outcome = tx.execute(status -> {
        // 锁用户行：同人并发领取在这一步串行化，输家随后必然查到那条流水
        users.lockBalance(uid);
        if (ledger.claimedByReason(uid, REASON) != null) {
          status.setRollbackOnly();
          return new Claim(Outcome.CLAIMED, 0, 0, progress.total());
        }
        users.credit(uid, AMOUNT);
        ledger.insert(uid, AMOUNT, REASON);
        return new Claim(Outcome.GRANTED, 0, NodeShapes.num(users.balanceOf(uid)), progress.total());
      });
      return outcome == null ? new Claim(Outcome.FAILED, 0, 0, progress.total()) : outcome;
    } catch (RuntimeException failed) {
      return new Claim(Outcome.FAILED, 0, 0, progress.total());
    }
  }

  /** {@code (现值, 目标)} 对，顺序与 Node 的徽章数组一致，只为数"够了几枚"。 */
  private record Progress(int total, int earned) {}

  /**
   * 八项读数 + 连签，逐条比阈值。<b>任何一步抛错都退回 (0, 0)</b>：
   * Node 的 listAchievements 失败时返回空数组，路由于是答"还差 0 枚"——
   * 这个反直觉的分支要原样保留，否则两栈在数据库抖动的瞬间行为就分叉了。
   */
  private Progress progress(long uid) {
    try {
      MoneyRows.Badges row = achievements.badges(uid);
      long arts = NodeShapes.num(row.getArticles());
      long reads = NodeShapes.num(row.getReads());
      long likes = NodeShapes.num(row.getLikes());
      long comments = NodeShapes.num(row.getComments());
      long balance = NodeShapes.num(row.getBalance());
      long following = NodeShapes.num(row.getFollowing());
      long fans = NodeShapes.num(row.getFans());
      long qa = NodeShapes.num(row.getQa());
      long streak = badgeStreak(uid);
      long[][] tiers = {
        {arts, 1}, {arts, 5}, {arts, 10},
        {reads, 100}, {reads, 1000},
        {likes, 10}, {likes, 50},
        {comments, 10},
        {streak, 3}, {streak, 7},
        {balance, 1000},
        {following, 3}, {fans, 5}, {qa, 10},
      };
      int earned = 0;
      for (long[] tier : tiers) {
        if (tier[0] >= tier[1]) {
          earned++;
        }
      }
      return new Progress(tiers.length, earned);
    } catch (RuntimeException unreadable) {
      // 行为与 Node 一致（空数组 → "还差 0 枚"），但必须留痕：
      // 这一分支同时是"数据真取不到"和"我写的 SQL 有问题"的兜底，不打印就只能靠猜。
      log.warn("成就计数失败，按未集齐处理：{}", unreadable.getMessage());
      return new Progress(0, 0);
    }
  }

  /**
   * 连签天数，从今天（或昨天）往回数，最多 30 天。
   *
   * <p>DATE 列在两栈的口径要钉死：Node 侧 mysql2 把它还原成"本地零点的 Date"，
   * 必须按本地分量取日历日（Node 原先用了 {@code String(date).slice(0,10)}，拿到的是
   * "Mon Sep 14" 这种串，永远匹配不上 → 连签徽章恒为 0、这 100 滴墨谁也领不到；
   * v18.1 已在 Node 侧修成 localDayKey）。JDBC 的 LocalDate 就是这个本地日历日，无需换算。
   */
  private long badgeStreak(long uid) {
    List<LocalDate> dates = money.checkinDates(uid, STREAK_WINDOW);
    Set<LocalDate> set = new HashSet<>(dates);
    LocalDate today = LocalDate.now();
    int offset = set.contains(today) ? 0 : set.contains(today.minusDays(1)) ? 1 : -1;
    long streak = 0;
    while (offset >= 0 && offset < STREAK_WINDOW && set.contains(today.minusDays(offset))) {
      streak++;
      offset++;
    }
    return streak;
  }
}
