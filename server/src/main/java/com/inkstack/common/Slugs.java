package com.inkstack.common;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * slug 生成，与 lib/importer.ts 的 makeSlug 同式。
 *
 * <p>中文标题在这里必然落到兜底分支（{@code [^a-z0-9]+} 把汉字整段换成连字符，
 * 再被首尾连字符规则清空），所以"同一时刻并发发布同名中文标题"会得到<b>完全相同</b>的候选 slug，
 * 撞唯一键是常态而不是意外——发布链路因此必须带撞键重试。
 */
public final class Slugs {

  private Slugs() {}

  private static final Pattern NON_ALNUM = Pattern.compile("[^a-z0-9]+");
  private static final Pattern EDGES = Pattern.compile("^-+|-+$");
  private static final Pattern TRAILING = Pattern.compile("-+$");

  public static String make(String title, int seq) {
    String base = title.toLowerCase(Locale.ROOT);
    base = NON_ALNUM.matcher(base).replaceAll("-");
    base = EDGES.matcher(base).replaceAll("");
    if (base.length() > 48) {
      base = base.substring(0, 48);
    }
    base = TRAILING.matcher(base).replaceAll("");
    if (!base.isEmpty()) {
      return base;
    }
    return "bo-" + NodeDates.utcDay().replace("-", "") + "-" + seq;
  }
}
