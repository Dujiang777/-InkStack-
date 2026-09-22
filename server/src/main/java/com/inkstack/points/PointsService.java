package com.inkstack.points;

import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.RewardCounterMapper;
import com.inkstack.mapper.UserMapper;
import java.time.LocalDate;
import java.util.OptionalLong;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/** 墨点（积分）发放与扣减。reason 字符串是与 Node 侧共用的业务键，不得改写。 */
@Service
public class PointsService {

  public static final String DAILY_QUOTA_REASON = "每日免费额度";
  public static final long DAILY_QUOTA = 30L;

  private final UserMapper users;
  private final PointLedgerMapper ledger;
  private final RewardCounterMapper counters;
  private final TransactionTemplate tx;

  public PointsService(
      UserMapper users, PointLedgerMapper ledger, RewardCounterMapper counters, TransactionTemplate tx) {
    this.users = users;
    this.ledger = ledger;
    this.counters = counters;
    this.tx = tx;
  }

  /**
   * 每日免费额度懒发放：靠"当天未发才更新"这条 UPDATE 的 affectedRows 判重，
   * 判重与流水必须同事务，否则会出现加了余额没落流水的账实不符。
   *
   * @return 实发后的余额；未发放（当天已发）时为 empty
   */
  @Transactional
  public OptionalLong grantDailyQuota(long uid) {
    if (users.grantQuotaIfAbsent(uid, DAILY_QUOTA, LocalDate.now()) != 1) {
      return OptionalLong.empty();
    }
    ledger.insert(uid, DAILY_QUOTA, DAILY_QUOTA_REASON);
    Long balance = users.balanceOf(uid);
    return OptionalLong.of(balance == null ? 0L : balance);
  }

  /**
   * 带每日上限的行为奖励（评论 +1/日 3 次、文章被评论 +2/日 10 次…）。
   *
   * <p>先计数、再判上限、最后发墨，三步同事务："超上限"这一支必须<b>把刚 +1 的计数回退掉</b>，
   * 否则被拒的那几次也白白吃掉当天额度。发墨与流水同理配对。Node 侧用 conn.rollback()，
   * 这里用 setRollbackOnly() 表达同一件事。
   *
   * @param capKey Node 侧的计数键（comment / comment_received …），两栈共用同一张表
   */
  public Reward grantCappedReward(long uid, long amount, String reason, String capKey, long dailyCap) {
    String today = LocalDate.now().toString();
    Reward outcome =
        tx.execute(
            status -> {
              counters.bump(uid, capKey, today);
              Long raw = counters.countOf(uid, capKey, today);
              long cnt = raw == null ? 0L : raw;
              if (cnt > dailyCap) {
                status.setRollbackOnly();
                return Reward.capReached();
              }
              if (users.credit(uid, amount) != 1) {
                status.setRollbackOnly();
                return Reward.notGranted();
              }
              ledger.insert(uid, amount, reason);
              return Reward.granted(users.balanceOf(uid));
            });
    return outcome == null ? Reward.notGranted() : outcome;
  }

  /** granted=false 且 capped=true 表示"今天领满了"；两者皆 false 是发墨本身没落上。 */
  public record Reward(boolean granted, boolean capped, long balance) {

    /** 工厂名不能与分量同名：record 已经占了 granted()/capped() 这两个签名。 */
    static Reward granted(Long balance) {
      return new Reward(true, false, balance == null ? 0L : balance);
    }

    static Reward notGranted() {
      return new Reward(false, false, 0L);
    }

    static Reward capReached() {
      return new Reward(false, true, 0L);
    }
  }
}
