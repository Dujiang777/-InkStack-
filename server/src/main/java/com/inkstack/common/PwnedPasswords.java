package com.inkstack.common;

import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 泄露密码检查（Have I Been Pwned 的 k-匿名模型）：只上送 SHA-1 前 5 位，
 * 拿回该前缀下的全部哈希尾部在本地比对——密码本身绝不离开本机。
 *
 * <p>fail-open 是刻意选择：3 秒超时或网络异常返回 -1（未知），调用方据此放行，
 * 不能让第三方接口挂掉时全站注册/改密一起停摆。
 */
@Component
public class PwnedPasswords {

  private static final Logger log = LoggerFactory.getLogger(PwnedPasswords.class);
  private static final Duration TIMEOUT = Duration.ofSeconds(3);
  private static final long CACHE_TTL_MS = 60 * 60 * 1000L;

  private final Map<String, Cached> cache = new ConcurrentHashMap<>();
  private final java.net.http.HttpClient http = java.net.http.HttpClient.newBuilder()
      .connectTimeout(TIMEOUT).build();

  private record Cached(String body, long at) {}

  /** @return 泄露次数；-1 表示未知（降级放行） */
  public int count(String password) {
    if (password == null || password.isEmpty()) {
      return 0;
    }
    try {
      String hash = sha1HexUpper(password);
      String prefix = hash.substring(0, 5);
      String suffix = hash.substring(5);
      String body = range(prefix);
      if (body == null) {
        return -1;
      }
      for (String line : body.split("\n")) {
        String[] parts = line.trim().split(":");
        if (parts.length == 2 && parts[0].equals(suffix)) {
          try {
            return Integer.parseInt(parts[1].trim());
          } catch (NumberFormatException malformed) {
            return 0;
          }
        }
      }
      return 0;
    } catch (Exception e) {
      log.warn("泄露密码检查降级放行：{}", e.getMessage());
      return -1;
    }
  }

  private String range(String prefix) throws Exception {
    Cached hit = cache.get(prefix);
    if (hit != null && System.currentTimeMillis() - hit.at() < CACHE_TTL_MS) {
      return hit.body();
    }
    HttpRequest req = HttpRequest.newBuilder(
            java.net.URI.create("https://api.pwnedpasswords.com/range/" + prefix))
        .timeout(TIMEOUT)
        .header("Add-Padding", "true")
        .GET().build();
    HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    if (res.statusCode() / 100 != 2) {
      return null;
    }
    cache.put(prefix, new Cached(res.body(), System.currentTimeMillis()));
    return res.body();
  }

  private static String sha1HexUpper(String value) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-1").digest(value.getBytes(StandardCharsets.UTF_8));
    StringBuilder sb = new StringBuilder();
    for (byte b : digest) {
      sb.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xf, 16)));
      sb.append(Character.toUpperCase(Character.forDigit(b & 0xf, 16)));
    }
    return sb.toString();
  }
}
