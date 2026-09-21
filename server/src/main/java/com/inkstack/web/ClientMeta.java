package com.inkstack.web;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 请求对端信息。IP 取值策略必须与 Node 的 middleware/audit 同判据：
 * 只有 TRUST_PROXY=1 才相信代理写入的 x-real-ip / XFF 末跳，否则取 XFF 首跳——
 * 反过来配会让伪造头绕过限流，或直接记错审计 IP。
 */
public record ClientMeta(String ip, String userAgent) {

  public static final int UA_LIMIT = 250;
  public static final int IP_LIMIT = 60;

  public static ClientMeta from(HttpServletRequest request, boolean trustProxy) {
    String xff = request.getHeader("x-forwarded-for");
    String realIp = trim(request.getHeader("x-real-ip"));
    String[] hops = xff == null ? new String[0] : xff.split(",");
    String firstHop = "";
    String lastHop = "";
    for (String hop : hops) {
      String value = hop.trim();
      if (!value.isEmpty()) {
        if (firstHop.isEmpty()) {
          firstHop = value;
        }
        lastHop = value;
      }
    }
    String ip = trustProxy
        ? (!realIp.isEmpty() ? realIp : (!lastHop.isEmpty() ? lastHop : "local"))
        : (!firstHop.isEmpty() ? firstHop : (!realIp.isEmpty() ? realIp : "local"));
    return new ClientMeta(cut(ip, IP_LIMIT), cut(trim(request.getHeader("user-agent")), UA_LIMIT));
  }

  /** Node 侧 `(ua ?? "").slice(0,250) || null`：空串一律落 NULL。 */
  public String uaOrNull() {
    return userAgent.isEmpty() ? null : userAgent;
  }

  public String ipOrNull() {
    return ip.isEmpty() ? null : ip;
  }

  private static String trim(String value) {
    return value == null ? "" : value.trim();
  }

  private static String cut(String value, int max) {
    return value.length() <= max ? value : value.substring(0, max);
  }
}
