package com.inkstack.money;

import java.util.Locale;

/** 成就墙的读视图：/me 页直接渲染这一份，字段名与 Node 的 Achievement 逐字对齐。 */
public final class BadgeViews {

  private BadgeViews() {}

  /**
   * 一枚成就。
   *
   * <p>{@code progressText} 是"当前值 / 目标值"的**本地化千分位**文案，Node 走
   * {@code n.toLocaleString()}。这里钉 {@link Locale#US} 而不是跟随 JVM 默认 locale：
   * 实测本机的 Node（zh-CN）与 en-US 对整数的分组符都是半角逗号，所以两者等价；
   * 而 Java 侧若不显式指定，就会跟着启动参数里的 {@code user.language} 走——
   * 换一台机器部署，"墨水富翁"从 1,000 变成 1 000 或 1.000 这种看得见的漂移。
   */
  public record Wall(String key, String name, String desc, String icon, boolean earned,
      double progress, String progressText) {

    public static Wall of(String key, String name, String desc, String icon, long current, long goal) {
      long shown = Math.min(current, goal);
      return new Wall(key, name, desc, icon, current >= goal,
          Math.min(1D, (double) shown / (double) goal),
          grouped(shown) + " / " + grouped(goal));
    }

    private static String grouped(long n) {
      return String.format(Locale.US, "%,d", n);
    }
  }
}
