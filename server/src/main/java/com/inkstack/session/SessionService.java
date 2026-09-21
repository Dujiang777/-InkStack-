package com.inkstack.session;

import com.inkstack.common.Hex;
import com.inkstack.entity.ActiveSession;
import com.inkstack.mapper.SessionMapper;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Service;

/**
 * 会话双保险：Cookie 里的 HMAC 签名挡伪造，sessions 表挡"已签发但已被吊销"。
 * 少任何一侧都退化成原实现想修的问题（改密/封号后旧 Cookie 仍然有效）。
 */
@Service
public class SessionService {

  private static final Logger log = LoggerFactory.getLogger(SessionService.class);
  private static final long TOUCH_THROTTLE_MS = 60_000L;

  private final SessionCodec codec;
  private final SessionMapper sessions;
  private final Map<Long, Long> lastSeen = new ConcurrentHashMap<>();

  public SessionService(SessionCodec codec, SessionMapper sessions) {
    this.codec = codec;
    this.sessions = sessions;
  }

  /** 签发会话：先落库（失败只降级为纯 Cookie 会话，与原实现一致，不阻断登录），再下发 Cookie。 */
  public void issue(long uid, ClientMeta meta, HttpServletResponse response) {
    SessionCodec.Issued issued = codec.issue(uid);
    try {
      sessions.register(uid, Hex.sha256Hex(issued.token()), meta.uaOrNull(), meta.ipOrNull(),
          Math.floorDiv(issued.expMs(), 1000L));
    } catch (RuntimeException e) {
      log.warn("会话入库失败（降级为纯 Cookie 会话）：{}", e.getMessage());
    }
    response.addHeader(HttpHeaders.SET_COOKIE, cookie(issued.token(), Duration.ofSeconds(SessionCodec.MAX_AGE_SECONDS)));
  }

  public Optional<SessionUser> resolve(HttpServletRequest request) {
    String token = readToken(request);
    Optional<SessionPayload> parsed = codec.verify(token);
    if (parsed.isEmpty()) {
      return Optional.empty();
    }
    try {
      ActiveSession row = sessions.findActive(Hex.sha256Hex(token));
      if (row == null || row.getUserId() != parsed.get().uid()) {
        return Optional.empty();
      }
      if (row.getBanned() != null && row.getBanned() == 1) {
        return Optional.empty();
      }
      touch(row.getSessionId());
      return Optional.of(new SessionUser(
          row.getUserId(), row.getNickname(), row.getEmail(), row.getRole(),
          row.getPointsBalance() == null ? 0L : row.getPointsBalance()));
    } catch (RuntimeException e) {
      // 原实现此处 catch-all 返回 null：库抖动时宁可掉登录态，不可把半截数据当已登录。
      log.warn("会话校验异常：{}", e.getMessage());
      return Optional.empty();
    }
  }

  public void revoke(HttpServletRequest request, HttpServletResponse response) {
    String token = readToken(request);
    if (token != null && !token.isBlank()) {
      try {
        sessions.revokeByTokenHash(Hex.sha256Hex(token));
      } catch (RuntimeException e) {
        log.warn("会话吊销失败（不影响登出）：{}", e.getMessage());
      }
    }
    response.addHeader(HttpHeaders.SET_COOKIE, cookie("", Duration.ZERO));
  }

  private String readToken(HttpServletRequest request) {
    if (request.getCookies() == null) {
      return null;
    }
    for (Cookie cookie : request.getCookies()) {
      if (SessionCodec.COOKIE_NAME.equals(cookie.getName())) {
        return cookie.getValue();
      }
    }
    return null;
  }

  private String cookie(String value, Duration maxAge) {
    return ResponseCookie.from(SessionCodec.COOKIE_NAME, value)
        .httpOnly(true)
        .sameSite("Lax")
        .path("/")
        .maxAge(maxAge)
        .secure(codec.cookieSecure())
        .build()
        .toString();
  }

  /** last_seen 节流：60 秒内不重复 UPDATE，避免每请求一次写放大。 */
  private void touch(Long sessionId) {
    long now = System.currentTimeMillis();
    Long previous = lastSeen.get(sessionId);
    if (previous != null && now - previous <= TOUCH_THROTTLE_MS) {
      return;
    }
    lastSeen.put(sessionId, now);
    try {
      sessions.touch(sessionId);
    } catch (RuntimeException e) {
      log.debug("last_seen 更新失败：{}", e.getMessage());
    }
  }
}
