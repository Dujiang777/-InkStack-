package com.inkstack.points;

import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.UserMapper;
import java.time.LocalDate;
import java.util.OptionalLong;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 墨点（积分）发放与扣减。reason 字符串是与 Node 侧共用的业务键，不得改写。 */
@Service
public class PointsService {

  public static final String DAILY_QUOTA_REASON = "每日免费额度";
  public static final long DAILY_QUOTA = 30L;

  private final UserMapper users;
  private final PointLedgerMapper ledger;

  public PointsService(UserMapper users, PointLedgerMapper ledger) {
    this.users = users;
    this.ledger = ledger;
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
}
