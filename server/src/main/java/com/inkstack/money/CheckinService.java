package com.inkstack.money;

import com.inkstack.common.NodeShapes;
import com.inkstack.mapper.MoneyMapper;
import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.UserMapper;
import java.time.LocalDate;
import java.util.HashSet;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 每日签到：连签档位发墨，是"积分从哪来"的常规补给。
 *
 * <p><b>签到行与发墨必须同事务</b>（Node v17.4 的教训）：两段式时"发墨失败 → 补偿删签到行"
 * 一旦补偿也失败，用户当天既没墨也签不了（主键已占位），且异常会冒成 500。
 * 现在任一步失败整体回滚，用户可原样重试。
 *
 * <p>7 天一周期的档位：第 1-2 天 +10，第 3-6 天 +20，第 7 天收官 +40，一周共 140 滴。
 * 自然日按<b>服务器本地时区</b>——两栈跑在同一台机器上时这一点是隐含前提，
 * 分开部署时需保证容器 TZ 一致，否则会在午夜前后出现"两边算的不是同一天"。
 */
@Service
public class CheckinService {

  private static final Logger log = LoggerFactory.getLogger(CheckinService.class);

  static final int CYCLE_DAYS = 7;
  /** 连签回看上限：与 Node 的 LIMIT 400 一致（够覆盖一年以上的连签）。 */
  private static final int STREAK_LOOKBACK = 400;
  /** 锁冲突重放次数（含首次）：与 Node 侧 checkin 路由的 attempts 一致。 */
  private static final int LOCK_ATTEMPTS = 3;

  /** 下一档进度；null = 下次签到就是收官/最高档。 */
  public record Tier(long days, long reward) {}

  public record Status(boolean checkedInToday, long streak, long cycleDay, long reward, Tier next) {}

  /** 签到结果：error 非空即 500；already 即"今天已签"（200，ok=false）。 */
  public record Post(
      String error, boolean already, long reward, long balance, long streak, long cycleDay, Tier next) {

    static Post fail(String error) {
      return new Post(error, false, 0, 0, 0, 0, null);
    }

    static Post alreadyToday() {
      return new Post(null, true, 0, 0, 0, 0, null);
    }

    static Post granted(long reward, long balance, long streak, long cycleDay, Tier next) {
      return new Post(null, false, reward, balance, streak, cycleDay, next);
    }
  }

  private final MoneyMapper money;
  private final UserMapper users;
  private final PointLedgerMapper ledger;
  private final TransactionTemplate tx;

  public CheckinService(MoneyMapper money, UserMapper users, PointLedgerMapper ledger, TransactionTemplate tx) {
    this.money = money;
    this.users = users;
    this.ledger = ledger;
    this.tx = tx;
  }

  /**
   * 本周期第几天。streak 为 0 时 JS 与 Java 的 {@code %} 同号规则一致，都会算出 0——
   * 这不是笔误而是"未签到时档位为空档"的展示语义，故这里刻意不用 floorMod 去"修"它。
   */
  static long cycleDayOf(long streak) {
    return ((streak - 1) % CYCLE_DAYS) + 1;
  }

  static long rewardForCycleDay(long cycleDay) {
    if (cycleDay >= CYCLE_DAYS) {
      return 40;
    }
    if (cycleDay >= 3) {
      return 20;
    }
    return 10;
  }

  /** 以"下一次签到后的周期天数"为基准算还差几天升档。 */
  static Tier nextTier(long streak) {
    long cd = cycleDayOf(streak + 1);
    if (cd >= CYCLE_DAYS) {
      return null;
    }
    if (cd >= 3) {
      return new Tier(CYCLE_DAYS - cd, 40);
    }
    return new Tier(3 - cd, 20);
  }

  /** 今天的签到态 + 下次实得。reward 语义统一为"下次签到实得"，与今天是否已签无关。 */
  public Status status(long uid) {
    boolean done = money.checkedInOn(uid, LocalDate.now()) != null;
    long streak = streak(uid);
    return new Status(done, streak, cycleDayOf(streak),
        rewardForCycleDay(cycleDayOf(streak + 1)), nextTier(streak));
  }

  /**
   * 连签天数：今天已签则从今天往回数，否则从昨天往回数。
   *
   * <p>DATE 列在 Java 侧是 LocalDate（JDBC 不做时区换算），与 Node 按本地分量拼的
   * 日历日键同序；这条判据在时区上必须和 {@link #status} 用的是同一个"今天"。
   */
  private long streak(long uid) {
    Set<LocalDate> days = new HashSet<>(money.checkinDates(uid, STREAK_LOOKBACK));
    LocalDate cursor = LocalDate.now();
    if (!days.contains(cursor)) {
      cursor = cursor.minusDays(1);
    }
    long streak = 0;
    while (days.contains(cursor)) {
      streak++;
      cursor = cursor.minusDays(1);
    }
    return streak;
  }

  /**
   * 签到一次：占主键 + 发墨 + 落流水在同一事务里。
   *
   * <p><b>为什么要重放</b>：同一个 (user_id, checkin_date) 被并发插入时，输的那一路未必拿到
   * 唯一键冲突——InnoDB 常直接把它判成死锁牺牲品（实测六路并发稳定出现 DeadlockLoser）。
   * 若就此回 500，用户看到"签到失败"，而墨其实已经由另一路发出去了。
   * 判据与 {@code lib/data.ts} 的 isRetryableLockError 同源：只有锁冲突类错误重放一次，
   * 第二次必然落到 {@code DuplicateKeyException} → "今天已签"。钱不动，只是把话说明白。
   */
  public Post checkin(long uid) {
    // 连签数在插入今天这行之前算 = "昨天为止的连签数"，今天签完即 +1
    long streakAfter = streak(uid) + 1;
    long cycleDay = cycleDayOf(streakAfter);
    long reward = rewardForCycleDay(cycleDay);
    Tier next = nextTier(streakAfter);
    LocalDate today = LocalDate.now();
    for (int attempt = 1; ; attempt++) {
      try {
        Post outcome = tx.execute(status -> {
          try {
            money.insertCheckin(uid, today);
          } catch (DataIntegrityViolationException duplicated) {
            // 主键 (user_id, checkin_date) 挡下的重复签到（含并发双击的败者）：不产生任何变更
            status.setRollbackOnly();
            return Post.alreadyToday();
          }
          if (users.credit(uid, reward) != 1) {
            status.setRollbackOnly();
            return Post.fail("墨水发放失败，请重试");
          }
          ledger.insert(uid, reward, "每日签到·周期第" + cycleDay + "天");
          return Post.granted(reward, NodeShapes.num(users.balanceOf(uid)), streakAfter, cycleDay, next);
        });
        return outcome == null ? Post.fail("签到失败，请稍后再试") : outcome;
      } catch (PessimisticLockingFailureException lockConflict) {
        if (attempt >= LOCK_ATTEMPTS) {
          log.warn("签到锁冲突重放后仍失败：uid={} kind={} msg={}",
              uid, lockConflict.getClass().getName(), lockConflict.getMessage());
          return Post.fail("签到失败，请稍后再试");
        }
        backoff(attempt);
      } catch (RuntimeException failed) {
        log.warn("签到整体回滚：uid={} kind={} msg={}", uid, failed.getClass().getName(), failed.getMessage());
        return Post.fail("签到失败，请稍后再试");
      }
    }
  }

  /** 退避一次：让赢家把事务走完。30ms 足够，且只多占一个请求线程这么长时间。 */
  private static void backoff(int attempt) {
    try {
      Thread.sleep(30L * attempt);
    } catch (InterruptedException ie) {
      Thread.currentThread().interrupt();
    }
  }
}
