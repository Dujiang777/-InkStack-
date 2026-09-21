package com.inkstack.api;

import com.inkstack.auth.EmailCodeService;
import com.inkstack.auth.PasswordHasher;
import com.inkstack.common.PwnedPasswords;
import com.inkstack.entity.User;
import com.inkstack.mapper.AuditMapper;
import com.inkstack.mapper.SessionMapper;
import com.inkstack.mapper.UserMapper;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /api/auth/reset —— 验证码重置密码。
 *
 * <p>与注册同一条修复口径：<b>先验码再判账号是否存在</b>，未注册邮箱统一收"请先获取邮箱验证码"，
 * 不给用假码试探枚举的机会。
 *
 * <p>重置成功即下线该账号<b>全部</b>会话（含当前）：能改密码说明凭据可信度已破，
 * 留着其它设备的登录态等于把门开着。
 */
@RestController
@RequestMapping("/api/auth")
public class ResetController {

  private static final String EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

  private final EmailCodeService codes;
  private final UserMapper users;
  private final SessionMapper sessions;
  private final AuditMapper audit;
  private final PwnedPasswords pwned;
  private final boolean trustProxy;

  public ResetController(EmailCodeService codes, UserMapper users, SessionMapper sessions,
      AuditMapper audit, PwnedPasswords pwned,
      @Value("${inkstack.trust-proxy:0}") String trustProxy) {
    this.codes = codes;
    this.users = users;
    this.sessions = sessions;
    this.audit = audit;
    this.pwned = pwned;
    this.trustProxy = "1".equals(trustProxy);
  }

  public record Body(String email, String code, String password) {}

  @PostMapping("/reset")
  public ResponseEntity<Map<String, Object>> reset(
      @RequestBody(required = false) Body body, HttpServletRequest request) {
    String email = body == null || body.email() == null ? "" : body.email().trim().toLowerCase();
    String code = body == null || body.code() == null ? "" : body.code().trim();
    String password = body == null || body.password() == null ? "" : body.password();

    if (!email.matches(EMAIL_PATTERN)) {
      return ResponseEntity.badRequest().body(Map.of("error", "邮箱格式不正确"));
    }
    if (!code.matches("^\\d{6}$")) {
      return ResponseEntity.badRequest().body(Map.of("error", "请输入 6 位邮箱验证码"));
    }
    if (password.length() < 8 || !password.matches(".*[a-zA-Z].*") || !password.matches(".*[0-9].*")) {
      return ResponseEntity.badRequest()
          .body(Map.of("error", "新密码至少 8 位，且需同时包含字母和数字"));
    }

    try {
      int leaked = pwned.count(password);
      if (leaked > 0) {
        return ResponseEntity.badRequest().body(Map.of("error",
            "该密码已出现在 " + leaked + " 次已知泄露中，为安全起见请换一个"));
      }
      EmailCodeService.Check check = codes.check(email, code, "reset");
      if (!check.ok()) {
        return ResponseEntity.badRequest().body(Map.of("error", check.error()));
      }
      User u = users.byEmailProbe(email);
      if (u == null) {
        return ResponseEntity.status(404).body(Map.of("error", "该邮箱未注册"));
      }
      users.replacePassword(u.getId(), PasswordHasher.hash(password));
      sessions.revokeAllForUser(u.getId());
      ClientMeta meta = ClientMeta.from(request, trustProxy);
      try {
        audit.insert(u.getId(), "password_reset", meta.ipOrNull(), meta.uaOrNull(), null);
      } catch (RuntimeException ignored) {
        // 审计失败不阻塞重置结果
      }
      return ResponseEntity.ok(Map.of("ok", true,
          "hint", "密码已重置，所有设备已下线，请用新密码登录"));
    } catch (RuntimeException e) {
      return ResponseEntity.status(500).body(Map.of("error", "重置失败，请稍后再试"));
    }
  }
}
