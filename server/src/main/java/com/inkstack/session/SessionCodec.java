package com.inkstack.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 与 Node 侧 lib/auth.ts 逐字节互操作的 ink_session 令牌编解码。
 *
 * <p>双轨期两套后端共用同一个 Cookie，因此格式任何一处偏差都会把用户劈成半登录态：
 * 载荷是 base64url(JSON)，签名覆盖的是<b>这段 base64url 字符串本身</b>的 UTF-8 字节，
 * 而非解码后的 JSON；密钥是 SESSION_SECRET 的原始 UTF-8 字节，不做任何 KDF。
 */
@Component
public class SessionCodec {

  public static final String COOKIE_NAME = "ink_session";
  public static final int MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

  private static final HexFormat HEX = HexFormat.of();

  private final ObjectMapper mapper = new ObjectMapper();
  private final byte[] secretBytes;
  private final boolean cookieSecure;

  public SessionCodec(
      @Value("${inkstack.session-secret}") String sessionSecret,
      @Value("${inkstack.site-url:}") String siteUrl,
      @Value("${INSECURE_COOKIE:0}") String insecureCookie) {
    this.secretBytes = sessionSecret.getBytes(StandardCharsets.UTF_8);
    // Node 侧：Secure 只在站点走 https 时启用；http 部署带上会导致浏览器拒收 Cookie，
    // 表现为"登录成功但仍是游客"。这里必须跟同一套判据。
    this.cookieSecure = siteUrl.startsWith("https://") && !"1".equals(insecureCookie);
  }

  public boolean cookieSecure() {
    return cookieSecure;
  }

  public Issued issue(long uid) {
    byte[] random = new byte[18];
    new java.security.SecureRandom().nextBytes(random);
    String sid = HEX.formatHex(random);
    long expMs = Instant.now().toEpochMilli() + MAX_AGE_SECONDS * 1000L;
    String payload = encode(new SessionPayload(sid, uid, expMs));
    return new Issued(payload + "." + sign(payload), sid, expMs);
  }

  public Optional<SessionPayload> verify(String token) {
    if (token == null || token.isBlank()) {
      return Optional.empty();
    }
    int dot = token.indexOf('.');
    if (dot <= 0 || dot != token.lastIndexOf('.') || dot == token.length() - 1) {
      return Optional.empty();
    }
    String payload = token.substring(0, dot);
    String signature = token.substring(dot + 1);
    if (!MessageDigest.isEqual(
        sign(payload).getBytes(StandardCharsets.UTF_8),
        signature.getBytes(StandardCharsets.UTF_8))) {
      return Optional.empty();
    }
    SessionPayload parsed;
    try {
      parsed = decode(payload);
    } catch (Exception malformed) {
      return Optional.empty();
    }
    if (parsed.sid() == null || parsed.sid().isBlank() || parsed.uid() <= 0) {
      return Optional.empty();
    }
    if (Instant.now().toEpochMilli() > parsed.exp()) {
      return Optional.empty();
    }
    return Optional.of(parsed);
  }

  private String encode(SessionPayload payload) {
    try {
      byte[] json = mapper.writeValueAsBytes(payload);
      return Base64.getUrlEncoder().withoutPadding().encodeToString(json);
    } catch (Exception e) {
      throw new IllegalStateException("会话载荷序列化失败", e);
    }
  }

  private SessionPayload decode(String payload) throws Exception {
    byte[] json = Base64.getUrlDecoder().decode(payload);
    return mapper.readValue(json, SessionPayload.class);
  }

  private String sign(String payload) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secretBytes, "HmacSHA256"));
      return Base64.getUrlEncoder().withoutPadding()
          .encodeToString(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException("HMAC 签名失败", e);
    }
  }

  public record Issued(String token, String sid, long expMs) {}
}
