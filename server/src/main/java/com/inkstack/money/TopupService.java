package com.inkstack.money;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.MoneyRows;
import com.inkstack.mapper.MoneyMapper;
import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.UserMapper;
import java.security.SecureRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 充值：套餐定义 + 下单 + 到账。
 *
 * <p>订单状态机只有一跳（pending → paid），幂等锚点是
 * {@code UPDATE ... WHERE status='pending'} 的 affectedRows，而不是先查后改——
 * 支付回调、收银台轮询、用户手抖重提会并发打同一单，只有条件更新能保证只到账一次。
 *
 * <p><b>到账通道目前仍是"开发自闭环"</b>：pay() 不验签、不查支付平台结果，
 * 所以生产环境整条前端自助到账通道必须关死（见 TopupController 的 501 分支）。
 * 真接微信支付时，由支付回调路由验签后调用本服务，不经过 HTTP 接口。
 */
@Service
public class TopupService {

  /** 到账流水的 reason 前缀：后面拼套餐名，是"这笔钱从哪来"的对账凭据。 */
  public static final String REASON_PREFIX = "充值到账·";
  /** 允许客户端自报的渠道名（仅记账用，不代表验签）。 */
  public static final List<String> CHANNELS = List.of("demo", "wechat", "alipay");

  /** 字段顺序即 JSON 顺序，前端套餐卡片按这个结构渲染。 */
  public record Pack(String key, String name, long cents, long points, String tag, String note) {}

  public static final List<Pack> PACKS = List.of(
      new Pack("starter", "尝鲜包", 600, 600, "", "约 60 次分身问答"),
      new Pack("standard", "标准包", 1800, 2200, "惠", "多送 200 点 · 约 7 篇 AI 长文"),
      new Pack("pro", "创作者包", 5000, 6500, "推荐", "多送 500 点 · 日更作者首选"),
      new Pack("studio", "工作室包", 12800, 17800, "", "多送 1000 点 · 团队/高频使用"));

  public record Order(boolean ok, String error, String orderNo, Pack pack) {

    static Order fail(String error) {
      return new Order(false, error, null, null);
    }
  }

  public record Pay(boolean ok, String error, long points, long balance, Pack pack) {

    static Pay fail(String error) {
      return new Pay(false, error, 0, 0, null);
    }
  }

  private static final SecureRandom RANDOM = new SecureRandom();
  private static final char[] BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz".toCharArray();
  private static final DateTimeFormatter ORDER_STAMP =
      DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

  private final MoneyMapper orders;
  private final UserMapper users;
  private final PointLedgerMapper ledger;
  private final TransactionTemplate tx;

  public TopupService(MoneyMapper orders, UserMapper users, PointLedgerMapper ledger, TransactionTemplate tx) {
    this.orders = orders;
    this.users = users;
    this.ledger = ledger;
    this.tx = tx;
  }

  public static Optional<Pack> findPack(String key) {
    return PACKS.stream().filter(p -> p.key().equals(key)).findFirst();
  }

  public Order createOrder(long uid, String packKey) {
    Pack pack = findPack(packKey).orElse(null);
    if (pack == null) {
      return Order.fail("套餐不存在");
    }
    String orderNo = makeOrderNo();
    try {
      orders.insertOrder(uid, orderNo, pack.key(), pack.cents(), pack.points());
      return new Order(true, null, orderNo, pack);
    } catch (RuntimeException failed) {
      return Order.fail("订单创建失败，请稍后再试");
    }
  }

  public Pay pay(long uid, String orderNo, String channel) {
    try {
      Pay outcome = tx.execute(status -> {
        MoneyRows.TopupOrder row = orders.lockOrder(orderNo, uid);
        if (row == null) {
          status.setRollbackOnly();
          return Pay.fail("订单不存在");
        }
        if (!"pending".equals(row.getStatus())) {
          status.setRollbackOnly();
          return Pay.fail("订单已支付或已关闭");
        }
        long points = NodeShapes.num(row.getPoints());
        if (orders.markOrderPaid(orderNo, channel) != 1) {
          status.setRollbackOnly();
          return Pay.fail("订单状态异常，请稍后再试");
        }
        if (users.credit(uid, points) != 1) {
          status.setRollbackOnly();
          return Pay.fail("到账失败，请稍后再试");
        }
        // 套餐可能已下架：查不到名字就用订单上存的 key 兜底，别让流水 reason 变成 "null"
        String name = findPack(row.getPackKey()).map(Pack::name).orElse(row.getPackKey());
        ledger.insert(uid, points, REASON_PREFIX + name);
        return new Pay(true, null, points, NodeShapes.num(users.balanceOf(uid)),
            findPack(row.getPackKey()).orElse(null));
      });
      return outcome == null ? Pay.fail("支付异常，请稍后再试") : outcome;
    } catch (RuntimeException failed) {
      return Pay.fail("支付异常，请稍后再试");
    }
  }

  /**
   * 订单号：{@code TP + 本地时间(14 位) + 4 位 base36}，靠 order_no 的唯一索引挡重号。
   *
   * <p>Node 用 {@code Math.random().toString(36).slice(2,6)}，尾数是 0 时会随机出 1~3 位短码；
   * 这里固定 4 位，号段更规整。订单号本身是随机值，不构成两栈可对拍的行为差。
   */
  private static String makeOrderNo() {
    StringBuilder suffix = new StringBuilder(4);
    for (int i = 0; i < 4; i++) {
      suffix.append(BASE36[RANDOM.nextInt(BASE36.length)]);
    }
    return "TP" + ORDER_STAMP.format(LocalDateTime.now()) + suffix.toString().toUpperCase();
  }
}
