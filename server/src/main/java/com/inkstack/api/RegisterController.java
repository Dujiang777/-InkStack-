package com.inkstack.api;

import com.inkstack.auth.EmailCodeService;
import com.inkstack.auth.PasswordHasher;
import com.inkstack.common.Nicknames;
import com.inkstack.common.PwnedPasswords;
import com.inkstack.entity.User;
import com.inkstack.mail.Mailer;
import com.inkstack.mapper.AuditMapper;
import com.inkstack.mapper.UserMapper;
import com.inkstack.session.SessionService;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /api/auth/register —— 邮箱验证码 + 昵称 + 密码建号，成功即签发会话。
 *
 * <p>顺序里有一条是安全修复，不能重排：<b>先验码、再判邮箱是否已注册</b>。
 * 修复前是反过来，任何人拿一个格式合法的假码（000000）反复打这个接口，
 * 靠 409/400 的差异就能枚举平台已注册邮箱。挪到验码之后，
 * 必须先真的收到发到该邮箱的验证码才能走到 409 这一支。
 *
 * <p>注册即送 100 滴墨由表上的 {@code points_balance DEFAULT 100} 承担，代码里不写死。
 */
@RestController
@RequestMapping("/api/auth")
public class RegisterController {

  private static final String EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

  private final EmailCodeService codes;
  private final UserMapper users;
  private final AuditMapper audit;
  private final SessionService sessionService;
  private final PwnedPasswords pwned;
  private final Mailer mailer;
  private final boolean trustProxy;

  public RegisterController(EmailCodeService codes, UserMapper users, AuditMapper audit,
      SessionService sessionService, PwnedPasswords pwned, Mailer mailer,
      @Value("${inkstack.trust-proxy:0}") String trustProxy) {
    this.codes = codes;
    this.users = users;
    this.audit = audit;
    this.sessionService = sessionService;
    this.pwned = pwned;
    this.mailer = mailer;
    this.trustProxy = "1".equals(trustProxy);
  }

  public record Body(String nickname, String email, String password, String code) {}

  private static String passwordWeakMessage() {
    return "密码至少 8 位，且需同时包含字母和数字";
  }

  private static boolean weakPassword(String pw) {
    return pw.length() < 8 || !pw.matches(".*[a-zA-Z].*") || !pw.matches(".*[0-9].*");
  }

  @PostMapping("/register")
  public ResponseEntity<Map<String, Object>> register(
      @RequestBody(required = false) Body body, HttpServletRequest request,
      HttpServletResponse response) {
    String raw = body == null || body.nickname() == null ? "" : body.nickname().trim();
    String nickname = Nicknames.clean(raw);
    String email = body == null || body.email() == null ? "" : body.email().trim().toLowerCase();
    String password = body == null || body.password() == null ? "" : body.password();
    String code = body == null || body.code() == null ? "" : body.code().trim();

    if (nickname.isEmpty() || raw.length() > 20) {
      return ResponseEntity.badRequest().body(Map.of("error", "昵称必填且不超过 20 字"));
    }
    if (!email.matches(EMAIL_PATTERN)) {
      return ResponseEntity.badRequest().body(Map.of("error", "邮箱格式不正确"));
    }
    if (weakPassword(password)) {
      return ResponseEntity.badRequest().body(Map.of("error", passwordWeakMessage()));
    }
    if (!code.matches("^\\d{6}$")) {
      return ResponseEntity.badRequest().body(Map.of("error", "请输入 6 位邮箱验证码"));
    }

    try {
      // 泄露密码检查：HIBP k-匿名，网络异常降级放行（-1）。只查一次，计数复用到文案里。
      int leaked = pwned.count(password);
      if (leaked > 0) {
        return ResponseEntity.badRequest().body(Map.of("error",
            "该密码已出现在 " + leaked + " 次已知泄露中，为安全起见请换一个（建议加符号或更长）"));
      }
      EmailCodeService.Check check = codes.check(email, code, "register");
      if (!check.ok()) {
        return ResponseEntity.badRequest().body(Map.of("error", check.error()));
      }
      if (users.byEmailProbe(email) != null) {
        return ResponseEntity.status(409).body(Map.of("error", "该邮箱已注册，可直接登录"));
      }
      User fresh = new User();
      fresh.setNickname(nickname);
      fresh.setEmail(email);
      fresh.setPasswordHash(PasswordHasher.hash(password));
      fresh.setAvatarText(nickname.substring(0, 1));
      users.insertRegistered(fresh);
      if (fresh.getId() == null) {
        throw new IllegalStateException("建号后未取回自增 id");
      }
      long uid = fresh.getId();

      ClientMeta meta = ClientMeta.from(request, trustProxy);
      sessionService.issue(uid, meta, response);
      try {
        audit.insert(uid, "register", meta.ipOrNull(), meta.uaOrNull(), email);
      } catch (RuntimeException ignored) {
        // 审计失败绝不阻塞注册主流程（与 Node logAudit 的静默降级同语义）
      }
      CompletableFuture.runAsync(() -> mailer.sendWelcome(email, nickname));

      Map<String, Object> user = new LinkedHashMap<>();
      user.put("id", uid);
      user.put("nickname", nickname);
      return ResponseEntity.ok(Map.of("ok", true, "user", user));
    } catch (RuntimeException e) {
      return ResponseEntity.status(500).body(Map.of("error", "注册失败，请稍后再试"));
    }
  }
}
