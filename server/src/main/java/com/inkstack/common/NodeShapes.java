package com.inkstack.common;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

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

  /** JS 的 {@code s.slice(0, n)}：null 视调用方决定，这里只管按 UTF-16 码元截断。 */
  public static String slice(String value, int max) {
    if (value == null) {
      return null;
    }
    return value.length() <= max ? value : value.substring(0, max);
  }

  /** EXISTS()/IF() 回 0/1，Node 用 Number(x) === 1 归真。 */
  public static boolean flag(Integer value) {
    return value != null && value == 1;
  }
}
