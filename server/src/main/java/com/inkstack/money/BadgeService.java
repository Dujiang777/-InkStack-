package com.inkstack.money;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.MoneyRows;
import com.inkstack.mapper.AchievementMapper;
import com.inkstack.mapper.MoneyMapper;
import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.UserMapper;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 集齐成就徽章的一次性领取（100 滴墨），外加 /me 页那面成就墙的判定。
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

  /**
   * 是否已经领过那 100 滴墨（/me 页的按钮文案用）。
   * 读不到时答"没领过"——与 Node 的 badgeRewardClaimed 同向。这个方向是安全的：
   * 最坏结果是多给一次点击，而真正的防线是 {@link #claim} 事务里那条流水判重。
   */
  public boolean rewardClaimed(long uid) {
    try {
      return ledger.claimedByReason(uid, REASON) != null;
    } catch (RuntimeException unreadable) {
      log.warn("徽章领取状态读不到，按未领取处理：{}", unreadable.getMessage());
      return false;
    }
  }

  /** {@code (总数, 已点亮)} 对。 */
  private record Progress(int total, int earned) {}

  /**
   * 成就墙一行：key / 文案 / 图标 / 用哪个读数 / 目标值。
   * 顺序与文案逐字照 Node 的 {@code listAchievements} 里那 14 句 {@code mk()} 搬——
   * 它们在 /me 页上是直接显示给读者看的。
   */
  private record Tier(String key, String name, String desc, String icon, String metric, long goal) {}

  private static final Tier[] TIERS = {
      new Tier("first-post", "处女作", "发布第一篇公开文章", "初", "articles", 1),
      new Tier("prolific", "笔耕不辍", "累计发布 5 篇文章", "耕", "articles", 5),
      new Tier("voluminous", "著作等身", "累计发布 10 篇文章", "著", "articles", 10),
      new Tier("reads-100", "初露锋芒", "文章总阅读破 100", "锋", "reads", 100),
      new Tier("reads-1000", "洛阳纸贵", "文章总阅读破 1000", "贵", "reads", 1000),
      new Tier("likes-10", "初识知音", "累计获赞 10", "知", "likes", 10),
      new Tier("likes-50", "人气之星", "累计获赞 50", "星", "likes", 50),
      new Tier("talk-10", "谈笑风生", "文章累计被评论 10 次", "谈", "comments", 10),
      new Tier("streak-3", "三日不辍", "连续签到 3 天", "恒", "streak", 3),
      new Tier("streak-7", "七日之约", "连续签到 7 天", "约", "streak", 7),
      new Tier("rich", "墨水富翁", "墨水余额达 1000 滴", "富", "balance", 1000),
      new Tier("social", "以文会友", "关注 3 位作者", "友", "following", 3),
      new Tier("beloved", "众望所归", "收获 5 位粉丝", "望", "fans", 5),
      new Tier("curious", "十问分身", "与分身问答 10 次", "问", "qa", 10),
  };

  /**
   * 整面成就墙。<b>任何一步抛错都回空列表</b>：Node 的 listAchievements 在 catch 里
   * {@code return []}，领取链路据此答"还差 0 枚"——这个反直觉的分支要原样保留，
   * 否则两栈在数据库抖动的瞬间行为就分叉了。
   *
   * <p>判定与展示共用 {@link #TIERS} 一处定义：改了墙上的门槛，领取条件跟着变，
   * 不会出现"墙上写着 5 篇解锁、实际 3 篇就发钱"这种两份名单各自漂移的事故。
   */
  public List<BadgeViews.Wall> wall(long uid) {
    try {
      MoneyRows.Badges row = achievements.badges(uid);
      Map<String, Long> values = new LinkedHashMap<>();
      values.put("articles", NodeShapes.num(row.getArticles()));
      values.put("reads", NodeShapes.num(row.getReads()));
      values.put("likes", NodeShapes.num(row.getLikes()));
      values.put("comments", NodeShapes.num(row.getComments()));
      values.put("balance", NodeShapes.num(row.getBalance()));
      values.put("following", NodeShapes.num(row.getFollowing()));
      values.put("fans", NodeShapes.num(row.getFans()));
      values.put("qa", NodeShapes.num(row.getQa()));
      values.put("streak", badgeStreak(uid));
      List<BadgeViews.Wall> out = new ArrayList<>();
      for (Tier t : TIERS) {
        out.add(BadgeViews.Wall.of(t.key(), t.name(), t.desc(), t.icon(),
            values.getOrDefault(t.metric(), 0L), t.goal()));
      }
      return out;
    } catch (RuntimeException unreadable) {
      // 空墙同时也是"徽章定义被我写坏了"的信号，所以必须留痕：
      // 静默回 [] 会让人以为用户真的一个成就都没有。
      log.warn("成就墙读数失败，按空墙处理：{}", unreadable.getMessage());
      return List.of();
    }
  }

  private Progress progress(long uid) {
    List<BadgeViews.Wall> wall = wall(uid);
    int earned = 0;
    for (BadgeViews.Wall a : wall) {
      if (a.earned()) {
        earned++;
      }
    }
    return new Progress(wall.size(), earned);
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
