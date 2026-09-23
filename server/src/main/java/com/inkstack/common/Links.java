package com.inkstack.common;

import java.net.IDN;

/**
 * 外链域名提取，对齐 {@code lib/link-policy.ts} 的 {@code extractDomain}——
 * 那里是 {@code new URL(...).hostname}，也就是 <b>WHATWG</b> 的解析口径，不是 {@code java.net.URL}。
 *
 * <p>两者在"该判无效"的输入上结论相反：{@code new URL("https://not a url")} 在 Node 抛错
 * （域名里不许有空格），而 {@code new java.net.URL(...)} 会高兴地把 {@code "not a url"} 当主机名返回。
 * 这条链路的产物是运营审核队列与外链放行白名单，宽松一侧等于把"随便写点什么都能进队列"
 * 变成常态，所以这里按 WHATWG 的禁字符表自己判。
 */
public final class Links {

  private Links() {}

  /** WHATWG 的 forbidden host code point 集（含 C0 控制符）。 */
  private static boolean forbidden(char c) {
    return c < 0x20 || c == ' ' || c == '#' || c == '/' || c == ':' || c == '<' || c == '>'
        || c == '?' || c == '@' || c == '[' || c == '\\' || c == ']' || c == '^' || c == '|';
  }

  /** 解析失败返回空串——调用方以"空即无效"回 400，与 Node 的 {@code if (!domain)} 同判。 */
  public static String domain(String url) {
    if (url == null) {
      return "";
    }
    String spec = url.startsWith("http") ? url : "https://" + url;
    // WHATWG 的 URL 构造器会先剥掉首尾的 C0 控制符与空白，再判 scheme
    spec = stripEdge(spec);
    int scheme = spec.indexOf("://");
    if (scheme <= 0 || !isHttpFamily(spec.substring(0, scheme))) {
      // 无 scheme 或不认的 scheme：Node 那边要么抛错要么 hostname 为空，结论都是无效
      return "";
    }
    String authority = spec.substring(scheme + 3);
    for (int i = 0; i < authority.length(); i++) {
      char c = authority.charAt(i);
      // 特殊方案的 URL 里 '\' 与 '/' 一样是权限段的结束符
      if (c == '/' || c == '\\' || c == '?' || c == '#') {
        authority = authority.substring(0, i);
        break;
      }
    }
    int at = authority.lastIndexOf('@');
    if (at >= 0) {
      authority = authority.substring(at + 1);
    }
    String host = authority;
    if (host.startsWith("[")) {
      int close = host.indexOf(']');
      if (close < 0) {
        return "";
      }
      host = host.substring(0, close + 1);
      return host.toLowerCase();
    }
    int colon = host.lastIndexOf(':');
    if (colon >= 0) {
      String port = host.substring(colon + 1);
      if (!port.isEmpty() && !port.chars().allMatch(Character::isDigit)) {
        return "";
      }
      host = host.substring(0, colon);
    }
    if (host.isEmpty()) {
      return "";
    }
    for (int i = 0; i < host.length(); i++) {
      if (forbidden(host.charAt(i))) {
        return "";
      }
    }
    // 特殊方案（http/https）走 IDNA：Node 的 hostname 对中文域名回 punycode
    String ascii = host;
    if (!isAscii(host)) {
      try {
        ascii = IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES);
      } catch (RuntimeException unparsable) {
        return "";
      }
    }
    return stripWww(ascii.toLowerCase());
  }

  private static boolean isHttpFamily(String scheme) {
    return scheme.equals("http") || scheme.equals("https");
  }

  private static String stripEdge(String value) {
    int start = 0;
    int end = value.length();
    while (start < end && (value.charAt(start) <= ' ')) {
      start++;
    }
    while (end > start && (value.charAt(end - 1) <= ' ')) {
      end--;
    }
    return value.substring(start, end);
  }

  private static boolean isAscii(String value) {
    for (int i = 0; i < value.length(); i++) {
      if (value.charAt(i) > 0x7F) {
        return false;
      }
    }
    return true;
  }

  /** Node 的 {@code .replace(/^www\./, "")}：只剥一层。 */
  private static String stripWww(String host) {
    return host.startsWith("www.") ? host.substring(4) : host;
  }
}
