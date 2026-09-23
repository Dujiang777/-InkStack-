package com.inkstack.common;

/**
 * 昵称净化，逐字对齐 lib/auth.ts 的 cleanNickname。
 *
 * <p>必须做而不是交给下游库兜底：昵称会进欢迎邮件的 <b>Subject 头</b> 与 <b>HTML 正文</b>、
 * 通知标题、审计日志行，而五个写入入口里有三个是第三方 OAuth 直接回传的昵称。
 */
public final class Nicknames {

  private Nicknames() {}

  public static String clean(Object raw) {
    return clean(raw, 20);
  }

  public static String clean(Object raw, int max) {
    String s = raw == null ? "" : String.valueOf(raw);
    s = s.replaceAll("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]", "");
    // 折叠与裁剪都必须走 JS 的空白判据：Java 的 \s 与 trim() 都不认全角空格，
    // "张　　三"在 Node 折成"张 三"、在 Java 原样留着，两侧昵称从此分叉。
    s = NodeShapes.jsCollapse(s);
    s = NodeShapes.jsTrim(s);
    return s.length() > max ? s.substring(0, max) : s;
  }
}
