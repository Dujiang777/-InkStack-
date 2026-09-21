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

  public static long num(Long value) {
    return value == null ? 0L : value;
  }

  /** EXISTS()/IF() 回 0/1，Node 用 Number(x) === 1 归真。 */
  public static boolean flag(Integer value) {
    return value != null && value == 1;
  }
}
