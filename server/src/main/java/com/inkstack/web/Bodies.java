package com.inkstack.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.MissingNode;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.List;
import org.springframework.util.StreamUtils;

/**
 * 请求体读取：对齐 Node 路由里的 {@code await req.json().catch(() => ({}))}。
 *
 * <p>不用 {@code @RequestBody} 是因为它的失败姿势不一样：JSON 缺失、格式错、类型不匹配
 * 都会被 Spring 拦成自己的 400 错误体，而 Node 那行 catch 一律退化成"空对象"，
 * 由业务代码给出自己的提示（"打赏档位须为 10 或 50 点墨"）。双轨期这两种 400
 * 长得不一样，对拍就会红——所以这里把"读不到就当空"的语义搬过来。
 */
public final class Bodies {

  private Bodies() {}

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final JsonNode EMPTY = MissingNode.getInstance();

  /** 只认 JSON 对象；其余（缺体、数组、标量、坏 JSON）按空对象处理。 */
  public static JsonNode json(HttpServletRequest request) {
    try {
      byte[] raw = StreamUtils.copyToByteArray(request.getInputStream());
      if (raw.length == 0) {
        return EMPTY;
      }
      JsonNode node = MAPPER.readTree(raw);
      return node != null && node.isObject() ? node : EMPTY;
    } catch (Exception unreadable) {
      return EMPTY;
    }
  }

  /** {@code Number(body[field])}：缺字段、null、布尔之外的非标量都给 NaN，由档位校验拒掉。 */
  public static double number(JsonNode body, String field) {
    JsonNode value = body.get(field);
    if (value == null || value.isNull()) {
      return Double.NaN;
    }
    if (value.isNumber()) {
      return value.doubleValue();
    }
    if (value.isBoolean()) {
      return value.booleanValue() ? 1d : 0d;
    }
    if (value.isTextual()) {
      try {
        return Double.parseDouble(value.asText().trim());
      } catch (NumberFormatException notANumber) {
        return Double.NaN;
      }
    }
    return Double.NaN;
  }

  /** {@code (body[field] ?? "").trim()}：缺字段退化为空串，不抛、不判类型。 */
  public static String text(JsonNode body, String field) {
    JsonNode value = body.get(field);
    if (value == null || value.isNull() || value.isContainerNode()) {
      return "";
    }
    return value.asText();
  }

  /**
   * 路径段里的数字 id，语义同 {@code Number(rawId)} + {@code Number.isInteger(id) && id > 0}：
   * 前后空白、{@code "1e2"}、{@code "12.0"} 这类写法两栈都认，非法值返回 0 由调用方按"不存在"处理。
   */
  public static long positiveId(String raw) {
    try {
      double parsed = Double.parseDouble(raw.trim());
      if (!Double.isFinite(parsed) || parsed != Math.rint(parsed) || parsed <= 0) {
        return 0L;
      }
      return (long) parsed;
    } catch (NumberFormatException notANumber) {
      return 0L;
    }
  }

  /**
   * JS 的 {@code String(value)}：标签这类"客户端可能塞任何类型"的数组要走它，
   * 否则 {@code tags:[1,2]} 在两栈会变成不同的字符串（{@code "2"} vs {@code "2.0"}）。
   */
  public static String stringOf(JsonNode value) {
    if (value == null || value.isMissingNode()) {
      return "undefined";
    }
    if (value.isNull()) {
      return "null";
    }
    if (value.isTextual()) {
      return value.asText();
    }
    if (value.isBoolean()) {
      return value.booleanValue() ? "true" : "false";
    }
    if (value.isNumber()) {
      double d = value.doubleValue();
      if (d == Math.rint(d) && Double.isFinite(d) && Math.abs(d) < 1e21) {
        return Long.toString((long) d);
      }
      return value.decimalValue().stripTrailingZeros().toPlainString();
    }
    if (value.isArray()) {
      // JS 的 String([a,b]) 是 join(",")，元素再各自递归
      List<String> parts = new ArrayList<>();
      value.forEach(item -> parts.add(stringOf(item)));
      return String.join(",", parts);
    }
    return "[object Object]";
  }

  /**
   * {@code Array.isArray(x) && x.length ? x.slice(0, limit).map(t => String(t).slice(0, eachMax)) : fallback}
   * ——空数组也算"没填"，与 Node 一样回退到默认标签。
   */
  public static List<String> tagArray(JsonNode body, String field, int limit, int eachMax, String fallback) {
    JsonNode node = body.get(field);
    if (node == null || !node.isArray() || node.isEmpty()) {
      return List.of(fallback);
    }
    List<String> out = new ArrayList<>();
    int i = 0;
    for (JsonNode item : node) {
      if (i++ >= limit) {
        break;
      }
      String text = stringOf(item);
      out.add(text.length() <= eachMax ? text : text.substring(0, eachMax));
    }
    return out;
  }
}
