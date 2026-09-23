package com.inkstack.common;

import java.net.IDN;

/**
 * WHATWG 口径的 http(s) 绝对地址解析，产物是 {@code new URL(spec).hostname} 的等价物。
 *
 * <p>SSRF 黑名单的输入就是这一枚 host，所以这里宽松一分、线上就洞开一分：
 * {@code java.net.URI} 与 {@code java.net.URL} 都不做 WHATWG 的 IPv4 归一化，
 * 而 {@code new URL("http://2130706433/").hostname} 是 {@code "127.0.0.1"}
 * （十进制整数、十六进制 {@code 0x7f000001}、八进制 {@code 0177.0.0.1}、短写 {@code 127.1}
 * 四种写法都会被规范成点分十进制）。用 JDK 自带的解析器，这些全都会以"域名"的身份进 DNS 查询，
 * 而操作系统照样按 IPv4 连出去——私网黑名单从此形同虚设。
 */
public final class NodeUrl {

  private NodeUrl() {}

  /** host 已归一化（IPv6 带方括号、域名已小写并 punycode），port 为 0 表示"未写"。 */
  public record Url(String scheme, String host, int port) {
    /** 回写绝对地址时用的 origin（不含路径）。 */
    public String origin() {
      return port == 0 ? scheme + "://" + host : scheme + "://" + host + ":" + port;
    }
  }

  /** 解析失败返回 null —— 对应 JS 侧 {@code new URL()} 抛错。 */
  public static Url parse(String spec) {
    if (spec == null) {
      return null;
    }
    String text = stripTabLfCr(c0Trim(spec));
    int schemeEnd = text.indexOf(':');
    if (schemeEnd <= 0) {
      return null;
    }
    String scheme = text.substring(0, schemeEnd).toLowerCase();
    if (!scheme.equals("http") && !scheme.equals("https")) {
      return null;
    }
    if (!text.regionMatches(true, schemeEnd + 1, "//", 0, 2)) {
      // 特殊方案下 WHATWG 容忍 "http:/host" 这种少一个斜杠的写法，但本项目的入口
      // 先被 /^https?:\/\//i 过了一遍，这里保持严格，避免给"看起来不像 URL 的串"开口子
      return null;
    }
    String rest = text.substring(schemeEnd + 3);
    int end = rest.length();
    for (int i = 0; i < rest.length(); i++) {
      char c = rest.charAt(i);
      if (c == '/' || c == '\\' || c == '?' || c == '#') {
        end = i;
        break;
      }
    }
    String authority = rest.substring(0, end);
    int at = authority.lastIndexOf('@');
    if (at >= 0) {
      authority = authority.substring(at + 1);
    }
    if (authority.startsWith("[")) {
      int close = authority.indexOf(']');
      if (close < 0) {
        return null;
      }
      String host = authority.substring(0, close + 1);
      String tail = authority.substring(close + 1);
      if (!tail.isEmpty() && !tail.startsWith(":")) {
        return null;
      }
      int port = tail.isEmpty() ? 0 : port(tail.substring(1));
      if (port < 0) {
        return null;
      }
      return new Url(scheme, host.toLowerCase(), port == defaultPort(scheme) ? 0 : port);
    }
    int colon = authority.lastIndexOf(':');
    String hostPart = authority;
    int port = 0;
    if (colon >= 0) {
      String portText = authority.substring(colon + 1);
      port = port(portText);
      if (port < 0) {
        return null;
      }
      hostPart = authority.substring(0, colon);
    }
    String host = host(hostPart);
    if (host.isEmpty()) {
      return null;
    }
    return new Url(scheme, host, port == defaultPort(scheme) ? 0 : port);
  }

  /**
   * 重定向目标的绝对化，对应 {@code new URL(location, base)}。
   *
   * <p>权限段（SSRF 判定唯一关心的部分）与 WHATWG 一致；路径按"基准目录 + 相对段"拼接，
   * {@code ./} 与 {@code ../} 逐个消化，够真实订阅源用。基准地址非法时返回 null。
   */
  public static String resolve(String baseSpec, String location) {
    if (location == null) {
      return null;
    }
    String ref = stripTabLfCr(c0Trim(location));
    Url base = parse(baseSpec);
    if (base == null) {
      return null;
    }
    if (ref.isEmpty()) {
      return baseSpec;
    }
    if (absolute(ref)) {
      return ref;
    }
    if (ref.startsWith("//")) {
      return base.scheme() + ":" + ref;
    }
    if (ref.charAt(0) == '/' || ref.charAt(0) == '?') {
      return base.origin() + ref;
    }
    return base.origin() + directory(baseSpec) + joinRef(ref);
  }

  /** 基准地址里最后一段斜杠之前的部分；没有路径时是 "/"。 */
  private static String directory(String baseSpec) {
    String text = stripTabLfCr(c0Trim(baseSpec));
    int authorityEnd = text.length();
    for (int i = text.indexOf("//") + 2; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c == '/' || c == '\\' || c == '?' || c == '#') {
        authorityEnd = i;
        break;
      }
    }
    int slash = text.lastIndexOf('/');
    return slash <= authorityEnd ? "/" : text.substring(authorityEnd, slash + 1);
  }

  private static boolean absolute(String ref) {
    int colon = ref.indexOf(':');
    if (colon <= 0) {
      return false;
    }
    for (int i = 0; i < colon; i++) {
      char c = ref.charAt(i);
      boolean schemeChar = i == 0 ? Character.isLetter(c)
          : Character.isLetterOrDigit(c) || c == '+' || c == '-' || c == '.';
      if (!schemeChar) {
        return false;
      }
    }
    // 只要"形如 scheme:…"就当绝对地址原样交回去：调用方要按 Node 的姿势区分
    // "协议不是 http(s)"（javascript:、ftp:）与"这个 URL 解析不了"两种不同的拒绝文案。
    return true;
  }

  private static String joinRef(String ref) {
    String cleaned = ref;
    while (cleaned.startsWith("./")) {
      cleaned = cleaned.substring(2);
    }
    while (cleaned.startsWith("../")) {
      cleaned = cleaned.substring(3);
    }
    return cleaned;
  }

  /** WHATWG：C0 控制符与空白在首尾被裁掉。 */
  private static String c0Trim(String value) {
    int start = 0;
    int end = value.length();
    while (start < end && value.charAt(start) <= ' ') {
      start++;
    }
    while (end > start && value.charAt(end - 1) <= ' ') {
      end--;
    }
    return value.substring(start, end);
  }

  /** 特殊方案的 URL 里 TAB / LF / CR  anywhere 都被删除。 */
  private static String stripTabLfCr(String value) {
    if (value.indexOf('\t') < 0 && value.indexOf('\n') < 0 && value.indexOf('\r') < 0) {
      return value;
    }
    StringBuilder sb = new StringBuilder(value.length());
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c != '\t' && c != '\n' && c != '\r') {
        sb.append(c);
      }
    }
    return sb.toString();
  }

  private static int defaultPort(String scheme) {
    return scheme.equals("https") ? 443 : 80;
  }

  /** 非法端口返回 -1：WHATWG 下非数字或超过 65535 都是"这个 URL 无效"。 */
  private static int port(String text) {
    if (text.isEmpty()) {
      return 0;
    }
    int value = 0;
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c < '0' || c > '9') {
        return -1;
      }
      value = value * 10 + (c - '0');
      if (value > 65535) {
        return -1;
      }
    }
    return value;
  }

  /** WHATWG 会把表意句号与全角句号当成标签分隔符，先换成 '.' 再判。 */
  private static String mapSeparators(String host) {
    StringBuilder sb = new StringBuilder(host.length());
    boolean changed = false;
    for (int i = 0; i < host.length(); i++) {
      char c = host.charAt(i);
      if (c == '。' || c == '．' || c == '｡') {
        sb.append('.');
        changed = true;
      } else {
        sb.append(c);
      }
    }
    return changed ? sb.toString() : host;
  }

  private static String host(String input) {
    if (input.isEmpty()) {
      return "";
    }
    String mapped = mapSeparators(input);
    if (endsInNumber(mapped)) {
      String v4 = ipv4(mapped);
      return v4 == null ? "" : v4;
    }
    for (int i = 0; i < mapped.length(); i++) {
      if (forbidden(mapped.charAt(i))) {
        return "";
      }
    }
    String lowered = mapped.toLowerCase();
    if (!isAscii(lowered)) {
      try {
        lowered = IDN.toASCII(lowered, IDN.USE_STD3_ASCII_RULES);
      } catch (RuntimeException unparsable) {
        return "";
      }
    }
    for (int i = 0; i < lowered.length(); i++) {
      if (forbidden(lowered.charAt(i))) {
        return "";
      }
    }
    return lowered;
  }

  private static boolean endsInNumber(String host) {
    String text = host;
    if (text.endsWith(".")) {
      text = text.substring(0, text.length() - 1);
    }
    int dot = text.lastIndexOf('.');
    String last = dot < 0 ? text : text.substring(dot + 1);
    if (last.isEmpty()) {
      return false;
    }
    String digits = last.regionMatches(true, 0, "0x", 0, 2) ? last.substring(2) : last;
    if (digits.isEmpty()) {
      return false;
    }
    for (int i = 0; i < digits.length(); i++) {
      if (Character.digit(digits.charAt(i), 16) < 0) {
        return false;
      }
    }
    return true;
  }

  /** WHATWG 的 IPv4 解析器：支持十进制 / 八进制 / 十六进制与 1~4 段写法，失败返回 null。 */
  private static String ipv4(String host) {
    String text = host;
    String[] raw = text.split("\\.", -1);
    int count = raw.length;
    if (count > 1 && raw[count - 1].isEmpty()) {
      count--;
    }
    if (count > 4) {
      return null;
    }
    long[] numbers = new long[count];
    for (int i = 0; i < count; i++) {
      Long parsed = number(raw[i]);
      if (parsed == null) {
        return null;
      }
      numbers[i] = parsed;
    }
    for (int i = 0; i < count - 1; i++) {
      if (numbers[i] > 255) {
        return null;
      }
    }
    long last = numbers[count - 1];
    long limit = (long) Math.pow(256, 5 - count);
    if (last >= limit) {
      return null;
    }
    int[] bytes = new int[4];
    int index = 0;
    for (; index < count - 1; index++) {
      bytes[index] = (int) numbers[index];
    }
    long tail = last;
    for (int i = 3; i > index; i--) {
      bytes[i] = (int) (tail % 256);
      tail /= 256;
    }
    bytes[index] = (int) tail;
    return bytes[0] + "." + bytes[1] + "." + bytes[2] + "." + bytes[3];
  }

  private static Long number(String part) {
    if (part.isEmpty()) {
      return null;
    }
    String text = part;
    int radix = 10;
    if (text.length() > 2 && (text.startsWith("0x") || text.startsWith("0X"))) {
      radix = 16;
      text = text.substring(2);
    } else if (text.length() > 1 && text.charAt(0) == '0') {
      radix = 8;
      text = text.substring(1);
    }
    if (text.isEmpty()) {
      return 0L;
    }
    long value = 0;
    for (int i = 0; i < text.length(); i++) {
      int digit = Character.digit(text.charAt(i), radix);
      if (digit < 0) {
        return null;
      }
      value = value * radix + digit;
      if (value > 0xFFFFFFFFL) {
        return null;
      }
    }
    return value;
  }

  private static boolean forbidden(char c) {
    return c < 0x20 || c == ' ' || c == '#' || c == '/' || c == ':' || c == '<' || c == '>'
        || c == '?' || c == '@' || c == '[' || c == '\\' || c == ']' || c == '^' || c == '|';
  }

  private static boolean isAscii(String value) {
    for (int i = 0; i < value.length(); i++) {
      if (value.charAt(i) > 0x7F) {
        return false;
      }
    }
    return true;
  }
}
