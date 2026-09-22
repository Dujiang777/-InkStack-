package com.inkstack.common;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * JS {@code new Date(字符串)} 的解析口径。
 *
 * <p>这是双轨期最容易静默分叉的一处：<b>只有日期</b>（{@code 2026-10-01}）按 <b>UTC</b> 零点算，
 * <b>带时间不带时区</b>（{@code 2026-10-01T08:00}，正是 datetime-local 控件给的东西）按<b>本地时区</b>算。
 * 两边都用各家的默认解析，早鸟折扣的截止时间就会差上八小时——同一篇文在 Node 已过期、在 Java 还在售，
 * 而这只在跨零点或跨时区边界附近才显形，对拍很难碰上。
 */
public final class NodeDates {

  private NodeDates() {}

  /** ES 的 Date Time String Format：日期必到日，时间可省秒与毫秒，时区可省。 */
  private static final Pattern ISO = Pattern.compile(
      "^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2}))?(?:\\.(\\d{1,3}))?"
          + "(Z|[+-]\\d{2}:?\\d{2})?)?$");
  /** V8 还收 {@code 2026/10/01 08:00} 这类斜杠写法，按本地时区。 */
  private static final Pattern SLASH = Pattern.compile(
      "^(\\d{4})/(\\d{1,2})/(\\d{1,2})(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?$");
  private static final Pattern YEAR_ONLY = Pattern.compile("^\\d{4}$");

  /** 无法解析返回 null —— 对应 JS 的 {@code isNaN(t.getTime())}。 */
  public static Instant parse(String raw) {
    if (raw == null) {
      return null;
    }
    String text = raw.trim();
    if (text.isEmpty()) {
      return null;
    }
    Matcher iso = ISO.matcher(text);
    if (iso.matches()) {
      return fromIso(iso);
    }
    Matcher slash = SLASH.matcher(text);
    if (slash.matches()) {
      LocalDateTime local = LocalDateTime.of(
          Integer.parseInt(slash.group(1)), Integer.parseInt(slash.group(2)), Integer.parseInt(slash.group(3)),
          slash.group(4) == null ? 0 : Integer.parseInt(slash.group(4)),
          slash.group(5) == null ? 0 : Integer.parseInt(slash.group(5)),
          slash.group(6) == null ? 0 : Integer.parseInt(slash.group(6)));
      return local.atZone(ZoneId.systemDefault()).toInstant();
    }
    if (YEAR_ONLY.matcher(text).matches()) {
      return LocalDate.of(Integer.parseInt(text), 1, 1).atStartOfDay(ZoneOffset.UTC).toInstant();
    }
    return null;
  }

  private static Instant fromIso(Matcher iso) {
    LocalDate date = LocalDate.of(
        Integer.parseInt(iso.group(1)), Integer.parseInt(iso.group(2)), Integer.parseInt(iso.group(3)));
    if (iso.group(4) == null) {
      // 纯日期：UTC 零点
      return date.atStartOfDay(ZoneOffset.UTC).toInstant();
    }
    LocalDateTime local = LocalDateTime.of(
        date.getYear(), date.getMonthValue(), date.getDayOfMonth(),
        Integer.parseInt(iso.group(4)), Integer.parseInt(iso.group(5)),
        iso.group(6) == null ? 0 : Integer.parseInt(iso.group(6)),
        iso.group(7) == null ? 0 : Integer.parseInt(padMillis(iso.group(7))) * 1_000_000);
    String zone = iso.group(8);
    if (zone == null) {
      // 带时间不带时区：本地时区
      return local.atZone(ZoneId.systemDefault()).toInstant();
    }
    if ("Z".equals(zone)) {
      return local.toInstant(ZoneOffset.UTC);
    }
    String cleaned = zone.replace(":", "");
    int sign = cleaned.charAt(0) == '-' ? -1 : 1;
    int hours = Integer.parseInt(cleaned.substring(1, 3));
    int minutes = Integer.parseInt(cleaned.substring(3));
    // 带 +08:00 的 08:00 = 00:00 UTC：本地墙钟减去偏移量才是瞬时
    return local.toInstant(ZoneOffset.UTC).minus(sign * (hours * 60L + minutes), ChronoUnit.MINUTES);
  }

  private static String padMillis(String millis) {
    return String.format("%-3s", millis).replace(' ', '0');
  }

  /** JS {@code d.toISOString().slice(0,19).replace("T"," ")}：UTC、秒精度、中间一个空格。 */
  public static String toSqlUtc(Instant instant) {
    return DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
        .format(instant.atZone(ZoneOffset.UTC));
  }

  /** JS {@code new Date().toISOString().slice(0,10)}：UTC 日历日，不是本地日。 */
  public static String utcDay() {
    return LocalDate.now(ZoneOffset.UTC).toString();
  }
}
