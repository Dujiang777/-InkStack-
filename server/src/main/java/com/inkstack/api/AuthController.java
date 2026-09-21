package com.inkstack.api;

import com.inkstack.auth.LoginRequest;
import com.inkstack.auth.LoginResult;
import com.inkstack.auth.LoginService;
import com.inkstack.mapper.AuditMapper;
import com.inkstack.points.PointsService;
import com.inkstack.session.SessionService;
import com.inkstack.session.SessionUser;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.OptionalLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.inkstack.web.Current;

/** 认证三态：登录签发、登出吊销、me 回读当前身份。响应键集与原实现严格一致。 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

  private static final Logger log = LoggerFactory.getLogger(AuthController.class);

  private final LoginService loginService;
  private final SessionService sessionService;
  private final PointsService points;
  private final AuditMapper audit;
  private final boolean trustProxy;

  public AuthController(
      LoginService loginService,
      SessionService sessionService,
      PointsService points,
      AuditMapper audit,
      @Value("${inkstack.trust-proxy:0}") String trustProxy) {
    this.loginService = loginService;
    this.sessionService = sessionService;
    this.points = points;
    this.audit = audit;
    this.trustProxy = "1".equals(trustProxy);
  }

  @PostMapping("/login")
  public ResponseEntity<Map<String, Object>> login(
      @RequestBody(required = false) LoginRequest body,
      HttpServletRequest request,
      HttpServletResponse response) {
    LoginRequest safe = body == null ? new LoginRequest(null, null, null) : body;
    ClientMeta meta = ClientMeta.from(request, trustProxy);
    LoginResult result = loginService.login(
        safe.email(), safe.password(), safe.totp(), meta, response);

    Map<String, Object> payload = new LinkedHashMap<>();
    if (result instanceof LoginResult.Success ok) {
      payload.put("ok", true);
      payload.put("user", Map.of("id", ok.id(), "nickname", ok.nickname()));
      return ResponseEntity.ok(payload);
    }
    if (result instanceof LoginResult.Need2fa need2fa) {
      payload.put("need2fa", true);
      payload.put("email", need2fa.email());
      return ResponseEntity.ok(payload);
    }
    if (result instanceof LoginResult.Locked locked) {
      return ResponseEntity.status(429)
          .header("Retry-After", String.valueOf(locked.retryAfterSec()))
          .body(Map.of("error", locked.error()));
    }
    LoginResult.Denied denied = (LoginResult.Denied) result;
    payload.put("error", denied.error());
    if (denied.need2fa()) {
      payload.put("need2fa", true);
    }
    return ResponseEntity.status(401).body(payload);
  }

  @PostMapping("/logout")
  public Map<String, Object> logout(HttpServletRequest request, HttpServletResponse response) {
    SessionUser me = sessionService.resolve(request).orElse(null);
    sessionService.revoke(request, response);
    try {
      audit.insert(me == null ? null : me.id(), "logout", null, null, null);
    } catch (RuntimeException e) {
      log.warn("登出审计失败：{}", e.getMessage());
    }
    return Map.of("ok", true);
  }

  @GetMapping("/me")
  public ResponseEntity<Map<String, Object>> me(@Current SessionUser me) {
    SessionUser current = me;
    if (current != null) {
      OptionalLong granted = points.grantDailyQuota(current.id());
      if (granted.isPresent()) {
        current = new SessionUser(
            current.id(), current.nickname(), current.email(), current.role(), granted.getAsLong());
      }
    }
    // 未登录也必须回 {"user":null}，前端据此区分"问过了"与"没问到"。
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("user", current);
    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
  }
}
