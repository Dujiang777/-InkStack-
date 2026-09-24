package com.inkstack.common;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigInteger;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 把 JDBC 结果转成 Node 侧 JSON 的取值语义。双轨期这些细节就是契约本身，
 * 差一处就会在对拍里表现成"看起来一样的接口其实不一样"。
 */
public final class NodeShapes {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  /** 与 JS Date#toISOString 同格式：毫秒恒显三位、UTC、尾写 Z。 */
  private static final DateTimeFormatter ISO =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");

  private NodeShapes() {}

  /** DATETIME → UTC ISO 串；NULL 保持 null（Node 三元的假分支同样是 null）。 */
  public static String iso(LocalDateTime value) {
    if (value == null) {
      return null;
    }
    // Node 的 mysql2 按进程时区把 DATETIME 读成 Date，再 toISOString；这里走系统时区同效。
    return ISO.format(value.atZone(ZoneId.systemDefault()).toInstant().atZone(ZoneOffset.UTC));
  }

  /** JSON 列 → 字符串数组；脏值一律空数组，不让一行坏数据把整个列表打挂。 */
  public static List<String> tags(String json) {
    if (json == null || json.isBlank()) {
      return List.of();
    }
    try {
      Object parsed = MAPPER.readValue(json, Object.class);
      if (parsed instanceof List<?> list) {
        return list.stream().map(String::valueOf).toList();
      }
      return List.of();
    } catch (Exception malformed) {
      return List.of();
    }
  }

  /** Node 的 String(r.x ?? "")：null 落空串，不是 "null"。 */
  public static String text(String value) {
    return value == null ? "" : value;
  }

  /**
   * DATETIME → 'YYYY-MM-DD'（UTC 日历日）。对齐 Node 的
   * {@code v instanceof Date ? v.toISOString().slice(0,10) : String(v ?? "")}：
   * NULL 落空串而不是 "null"，这一点曾让 /sitemap.xml 整站 500。
   */
  public static String day(LocalDateTime value) {
    return value == null ? "" : iso(value).substring(0, 10);
  }

  public static long num(Long value) {
    return value == null ? 0L : value;
  }

  /**
   * JS 的 {@code Number(字符串)}，按 StringNumericLiteral 判形状后再取值。
   *
   * <p>不能直接拿 {@link Double#parseDouble} 顶替：JDK 认 {@code "1d"}、{@code "0x1p3"}
   * 却不认 {@code "0x10"}，JS 正相反——十六进制/八进制/二进制<b>整数字面量</b>都认
   * （{@code Number("0x10") === 16}），带类型后缀的都是 NaN。用在查询参数上，
   * "这个参数到底是不是数字"两侧就会给出不同答案，而这正是双轨期最贵的一类分歧。
   *
   * @return 解析出的值；不是合法数字字面量时返回 {@link Double#NaN}（与 JS 同）
   */
  public static double jsNumber(String raw) {
    if (raw == null) {
      return 0;                       // JS: Number(null) === 0
    }
    String s = raw.replaceAll("^" + JS_SPACE + "+|" + JS_SPACE + "+$", "");
    if (s.isEmpty()) {
      return 0;                       // JS: Number("") === Number("   ") === 0
    }
    int sign = 1;
    if (s.startsWith("+")) {
      s = s.substring(1);
    } else if (s.startsWith("-")) {
      sign = -1;
      s = s.substring(1);
    }
    if (s.equals("Infinity")) {
      return sign * Double.POSITIVE_INFINITY;
    }
    if (s.equals("NaN")) {
      return Double.NaN;              // 带负号的 NaN 还是 NaN
    }
    String marker = s.toLowerCase();
    int radix = marker.startsWith("0x") ? 16 : marker.startsWith("0o") ? 8
        : marker.startsWith("0b") ? 2 : 0;
    if (radix != 0) {
      return sign * radixValue(s.substring(2), radix);
    }
    if (!JS_DECIMAL.matcher(s).matches()) {
      return Double.NaN;
    }
    return sign * Double.parseDouble(s);
  }

  /** 进位字面量的取值：空串（{@code "0x"}）与非法数字符都是 NaN，与 JS 一致。 */
  private static double radixValue(String digits, int radix) {
    try {
      return new BigInteger(digits, radix).doubleValue();
    } catch (NumberFormatException notANumber) {
      return Double.NaN;
    }
  }

  /** StringNumericLiteral 的十进制分支：{@code 1} / {@code 1.} / {@code .5} / {@code 1e-3}。 */
  private static final Pattern JS_DECIMAL =
      Pattern.compile("(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?");

  /**
   * 与 JS {@code String.prototype.trim} 等价的裁剪。Java 的两个内建版本都不等价，而且差别
   * 正好落在中文内容上：{@code trim()} 只认 &lt;=U+0020，全角空格 U+3000 裁不掉；
   * {@code strip()} 走 {@code Character.isWhitespace}，而它把不换行空格 U+00A0 与 BOM U+FEFF
   * 判成非空白——于是"纯全角空格的评论"在 Node 是"内容不能为空"，在 Java 却正常落库。
   */
  public static String jsTrim(String value) {
    if (value == null) {
      return "";
    }
    int start = 0;
    int end = value.length();
    while (start < end && isJsSpace(value.charAt(start))) {
      start++;
    }
    while (end > start && isJsSpace(value.charAt(end - 1))) {
      end--;
    }
    return value.substring(start, end);
  }

  private static boolean isJsSpace(char c) {
    return switch (c) {
      case '\t', '\n', '\u000B', '\f', '\r', ' ', '\u00A0', '\u1680', '\u2028', '\u2029',
              '\u202F', '\u205F', '\u3000', '\uFEFF' ->
          true;
      default -> c >= '\u2000' && c <= '\u200A';
    };
  }

  /** {@link #jsTrim} 与 {@link #jsCollapse} 共用的判据，口径只留一处。 */
  public static boolean jsWhitespace(char c) {
    return isJsSpace(c);
  }

  /**
   * 与 {@link #jsWhitespace} 同集合的正则字符类（不含方括号），
   * 需要拼否定形式 {@code [^…]} 的调用方用它自己包一层。
   */
  public static final String JS_SPACE_CHARS =
      "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";

  /** {@link #jsWhitespace} 的正则形式，供"照抄 JS 正则"的地方拼进去用。 */
  public static final String JS_SPACE = "[" + JS_SPACE_CHARS + "]";

  /**
   * JS 的 {@code s.replace(/\s{2,}/g, " ")}：两个以上空白折成一个半角空格。
   *
   * <p>不能用 {@code replaceAll("\\s{2,}", " ")}——Java 的 {@code \s} 少认全角空格、
   * {@code U+00A0}、{@code U+2028/29} 等一整排，昵称里的"张　　三"（两个全角空格）
   * 在 Node 会折成一个、在 Java 原样留着，两侧的昵称从此不同。
   */
  public static String jsCollapse(String value) {
    return squeeze(value, true);
  }

  /** JS 的 {@code s.replace(/\s+/g, " ")}：任意一段空白折成<b>一个</b>半角空格（单个也折）。 */
  public static String jsSqueeze(String value) {
    return squeeze(value, false);
  }

  private static String squeeze(String value, boolean keepSingleton) {
    if (value == null) {
      return "";
    }
    StringBuilder out = new StringBuilder(value.length());
    int i = 0;
    while (i < value.length()) {
      if (!isJsSpace(value.charAt(i))) {
        out.append(value.charAt(i++));
        continue;
      }
      int j = i;
      while (j < value.length() && isJsSpace(value.charAt(j))) {
        j++;
      }
      boolean single = j - i == 1;
      out.append(keepSingleton && single ? value.charAt(i) : ' ');
      i = j;
    }
    return out.toString();
  }

  /** JS 的 {@code s.slice(0, n)}：null 视调用方决定，这里只管按 UTF-16 码元截断。 */
  public static String slice(String value, int max) {
    if (value == null) {
      return null;
    }
    return value.length() <= max ? value : value.substring(0, max);
  }

  /**
   * JS 的 {@code s.slice(from, to)}——<b>越界不报错</b>，端点各自被夹到 [0, length]。
   *
   * <p>这条在移植里必须存在而不是"反正下标算得准"：JS 里 {@code raw.slice(4, 8)} 碰到
   * 只有 7 个字符的串就安静地给出 3 个字符，Java 的 {@code substring(4, 8)} 直接抛
   * StringIndexOutOfBoundsException。备份码就是撞在这一条上（base64url 去掉 -/_ 之后
   * 长度本来就会掉），表现为"偶发的 500"，最难复现也最容易被误判成环境问题。
   */
  public static String slice(String value, int from, int to) {
    if (value == null) {
      return "";
    }
    int len = value.length();
    int start = Math.min(Math.max(from < 0 ? len + from : from, 0), len);
    int end = Math.min(Math.max(to < 0 ? len + to : to, 0), len);
    return end <= start ? "" : value.substring(start, end);
  }

  /** EXISTS()/IF() 回 0/1，Node 用 Number(x) === 1 归真。 */
  public static boolean flag(Integer value) {
    return value != null && value == 1;
  }
}
