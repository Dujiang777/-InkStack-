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
  /**
   * RSS 2.0 的 pubDate 是 RFC 1123（{@code Mon, 23 Sep 2026 08:00:00 GMT}），
   * V8 的遗留解析器还收两位年、无星期、无秒、无时区（按本地）与 {@code +0800} 这些写法。
   * 星期名一律不参与校验（V8 也不校验），命名时区（EST 之类）判为不可解析。
   */
  private static final Pattern RFC1123 = Pattern.compile(
      "^(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\\s+)?(\\d{1,2})\\s+"
          + "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+(\\d{2,4})"
          + "(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?(?:\\s+(gmt|ut|utc|z|[+-]\\d{4}))?$",
      Pattern.CASE_INSENSITIVE);

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
    Matcher rfc = RFC1123.matcher(text);
    if (rfc.matches()) {
      return fromRfc(rfc);
    }
    if (YEAR_ONLY.matcher(text).matches()) {
      return LocalDate.of(Integer.parseInt(text), 1, 1).atStartOfDay(ZoneOffset.UTC).toInstant();
    }
    return null;
  }

  private static final String[] MONTHS = {"jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec"};

  private static Instant fromRfc(Matcher rfc) {
    int day = Integer.parseInt(rfc.group(1));
    String mon = rfc.group(2).toLowerCase();
    int month = -1;
    for (int i = 0; i < MONTHS.length; i++) {
      if (MONTHS[i].equals(mon)) {
        month = i + 1;
        break;
      }
    }
    if (month < 0) {
      return null;
    }
    // V8 的两位年口径：0-49 落 2000 段，50-99 落 1900 段
    int year = Integer.parseInt(rfc.group(3));
    if (rfc.group(3).length() == 2) {
      year += year < 50 ? 2000 : 1900;
    }
    int hour = rfc.group(4) == null ? 0 : Integer.parseInt(rfc.group(4));
    int minute = rfc.group(5) == null ? 0 : Integer.parseInt(rfc.group(5));
    int second = rfc.group(6) == null ? 0 : Integer.parseInt(rfc.group(6));
    if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null;
    }
    LocalDateTime wall = LocalDateTime.of(year, month, day, hour, minute, second);
    String zone = rfc.group(7);
    if (zone == null) {
      // 没时间字段时 V8 也给本地零点（"Mon, 23 Sep 2026" → 本地 00:00），与 ISO 纯日期按 UTC 相反
      return wall.atZone(ZoneId.systemDefault()).toInstant();
    }
    char head = zone.charAt(0);
    if (head == '+' || head == '-') {
      int sign = head == '-' ? -1 : 1;
      int offsetMinutes = sign * (Integer.parseInt(NodeShapes.slice(zone, 1, 3)) * 60
          + Integer.parseInt(NodeShapes.slice(zone, 3, 5)));
      return wall.toInstant(ZoneOffset.ofTotalSeconds(offsetMinutes * 60));
    }
    return wall.toInstant(ZoneOffset.UTC);
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

  /**
   * mysql2 把一个 {@code Date} 当参数绑进 SQL 时的口径：<b>驱动本地时区</b>的墙钟，
   * 且固定带三位毫秒（{@code '2026-09-23 10:00:00.537'}）。
   *
   * <p>毫秒这一段不是啰嗦：目标列是 {@code DATETIME}（零位小数），MySQL 对超出精度的部分
   * <b>四舍五入</b>而不是截断——截着写会让 Java 比 Node 少一秒，且正好在 .500 以上时发生。
   */
  public static String toSqlLocal(Instant instant) {
    return DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS")
        .format(instant.atZone(ZoneId.systemDefault()));
  }

  /** JS {@code new Date().toISOString().slice(0,10)}：UTC 日历日，不是本地日。 */
  public static String utcDay() {
    return LocalDate.now(ZoneOffset.UTC).toString();
  }
}
