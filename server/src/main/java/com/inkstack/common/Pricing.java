package com.inkstack.common;

import java.time.LocalDateTime;

/**
 * 分账与计价规则。这两条是<b>钱</b>的口径，读侧（列表页显示的"付费 20 墨"）和写侧
 * （真的扣 20 墨）必须同源，否则前端标价与实扣会随早鸟到时而分叉——
 * 所以从 SeriesService 里提出来，两侧共用这一份。
 */
public final class Pricing {

  /** 解锁分账：作者 70%、平台 30%。 */
  public static final double UNLOCK_SHARE = 0.7;
  /** 打包解锁沿用同一比例（Node 里两处都是 0.7）。 */
  public static final double BUNDLE_SHARE = 0.7;
  /** 打赏分账：作者 90%、平台 10%。 */
  public static final double TIP_SHARE = 0.9;

  private Pricing() {}

  /**
   * 早鸟价：折扣有效（0 &lt; 折扣 &lt; 原价 且未到期）取折扣，否则原价。
   * 到期判定用"不晚于此刻即失效"，与 Node 的 {@code getTime() <= Date.now()} 同边界。
   */
  public static long unlockPrice(long original, long discount, LocalDateTime discountUntil) {
    if (original <= 0 || discount <= 0 || discount >= original) {
      return original;
    }
    if (discountUntil != null && !discountUntil.isAfter(LocalDateTime.now())) {
      return original;
    }
    return discount;
  }

  /**
   * 作者所得 = 向下取整的比例分成。<b>刻意走 double 乘法</b>：JS 里 {@code Math.floor(x * 0.7)}
   * 是 IEEE-754 double 运算，换成整数乘除在极端价上会差 1 滴墨，对拍就成了"说不清的差"。
   */
  public static long authorShare(long amount, double ratio) {
    return (long) Math.floor(amount * ratio);
  }
}
