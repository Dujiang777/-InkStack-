package com.inkstack.api;

import com.inkstack.auth.OauthService;
import com.inkstack.session.SessionService;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 第三方登录的对外端点：providers / {p} / {p}/status / {p}/callback。
 *
 * <p>state 是防 CSRF 的全部依托：发起时写一枚 provider 专属的 10 分钟 HttpOnly Cookie，
 * 回调时<b>先清再比</b>——清掉保证同一枚 state 不能用两次，比对失败一律 302 回登录页，
 * 绝不在应答里透露"是 state 不对还是 code 不对"这类可用于试探的差异。
 */
@RestController
@RequestMapping("/api/auth")
public class OauthController {

  private static final String[] PROVIDERS = {"github", "gitee", "qq"};
  private static final long STATE_TTL_SECONDS = 600;

  private final OauthService oauth;
  private final SessionService sessionService;
  private final String siteUrl;
  private final boolean trustProxy;

  public OauthController(OauthService oauth, SessionService sessionService,
      @Value("${inkstack.site-url:}") String siteUrl,
      @Value("${inkstack.trust-proxy:0}") String trustProxy) {
    this.oauth = oauth;
    this.sessionService = sessionService;
    this.siteUrl = siteUrl == null ? "" : siteUrl.trim();
    this.trustProxy = "1".equals(trustProxy);
  }

  @GetMapping("/providers")
  public Map<String, Object> providers() {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    for (String p : PROVIDERS) {
      body.put(p, oauth.enabled(p));
    }
    return body;
  }

  @GetMapping("/{provider}/status")
  public ResponseEntity<Map<String, Object>> status(@PathVariable String provider) {
    if (!isProvider(provider)) {
      return ResponseEntity.notFound().build();
    }
    return ResponseEntity.ok(Map.of("ok", true, "enabled", oauth.enabled(provider)));
  }

  @GetMapping("/{provider}")
  public ResponseEntity<?> start(@PathVariable String provider, HttpServletRequest request,
      HttpServletResponse response) {
    if (!isProvider(provider)) {
      return ResponseEntity.notFound().build();
    }
    if (!oauth.enabled(provider)) {
      // 凭证未配置时回 JSON 提示（不跳转），前端据此展示"暂未配置"气泡
      return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(
          Map.of("ok", false, "error", label(provider) + "登录暂未配置凭证，敬请期待"));
    }
    String state = oauth.newState();
    response.addHeader(HttpHeaders.SET_COOKIE,
        ResponseCookie.from(OauthService.stateCookie(provider), state)
            .httpOnly(true).sameSite("Lax").path("/").maxAge(STATE_TTL_SECONDS).build().toString());
    String redirectUri = oauth.callbackBase(provider, origin(request), "/api/auth/" + provider + "/callback");
    return ResponseEntity.status(HttpStatus.FOUND)
        .location(URI.create(oauth.authorizeUrl(provider, state, redirectUri))).build();
  }

  @GetMapping("/{provider}/callback")
  public ResponseEntity<Void> callback(@PathVariable String provider,
      @RequestParam(name = "code", defaultValue = "") String code,
      @RequestParam(name = "state", defaultValue = "") String state,
      HttpServletRequest request, HttpServletResponse response) {
    if (!isProvider(provider)) {
      return ResponseEntity.notFound().build();
    }
    String name = OauthService.stateCookie(provider);
    String saved = readCookie(request, name);
    // 先焚再比：无论成败，这枚 state 都不能再用
    response.addHeader(HttpHeaders.SET_COOKIE,
        ResponseCookie.from(name, "").httpOnly(true).path("/").maxAge(0).build().toString());
    if (!oauth.enabled(provider)) {
      return fail(provider, "disabled", request);
    }
    if (code.isEmpty() || state.isEmpty() || !state.equals(saved)) {
      return fail(provider, "state", request);
    }
    String redirectUri = oauth.callbackBase(provider, origin(request), "/api/auth/" + provider + "/callback");
    OauthService.Result result = oauth.callback(provider, code, redirectUri);
    if (result.failure() != null) {
      return fail(provider, result.failure(), request);
    }
    sessionService.issue(result.uid(), ClientMeta.from(request, trustProxy), response);
    return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(base(request) + "/")).build();
  }

  /** 未配置凭证时的提示文案：大小写与空格都和 Node 一致（前端直接显示这句）。 */
  private static String label(String provider) {
    return switch (provider) {
      case "github" -> "GitHub ";
      case "gitee" -> "Gitee ";
      default -> "QQ ";
    };
  }

  private static boolean isProvider(String provider) {
    for (String p : PROVIDERS) {
      if (p.equals(provider)) {
        return true;
      }
    }
    return false;
  }

  private ResponseEntity<Void> fail(String provider, String reason, HttpServletRequest request) {
    return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(
        base(request) + "/login?oauth=" + provider + "&err=" + reason)).build();
  }

  /** 站点基准：显式配了 site-url 就一律用它，否则退回请求 origin（只在本机直连时才正确）。 */
  private String base(HttpServletRequest request) {
    return siteUrl.isEmpty() ? origin(request) : trim(siteUrl);
  }

  private static String origin(HttpServletRequest request) {
    String scheme = request.isSecure() ? "https" : "http";
    int port = request.getServerPort();
    boolean standard = ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
    return scheme + "://" + request.getHeader("host") + (standard ? "" : ":" + port);
  }

  private static String trim(String value) {
    return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
  }

  private static String readCookie(HttpServletRequest request, String name) {
    Cookie[] cookies = request.getCookies();
    if (cookies == null) {
      return "";
    }
    for (Cookie c : cookies) {
      if (name.equals(c.getName())) {
        return c.getValue();
      }
    }
    return "";
  }
}
