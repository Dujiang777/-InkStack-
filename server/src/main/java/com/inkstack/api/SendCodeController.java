package com.inkstack.api;

import com.inkstack.auth.EmailCodeService;
import com.inkstack.auth.LoginGuard;
import com.inkstack.entity.User;
import com.inkstack.mail.Mailer;
import com.inkstack.mapper.UserMapper;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /api/auth/send-code —— 与 Node 版逐分支对齐，包括<b>判定顺序</b>：
 * IP 频控先于请求体解析（否则攻击者能用不合法 body 免费试探），邮箱格式合法才计入这次频控额度。
 *
 * <p>purpose 三分支的存在性用不同状态码回给<b>已持有验证码的人</b>：register 撞已注册 409、
 * reset/twofa 找不到账号 404。这个差异本身就是枚举面，所以注册路径把存在性判断挪到了
 * 验证码校验之后（v17.2 的修复口径），这里不"顺手统一"成一致的状态码。
 */
@RestController
@RequestMapping("/api/auth")
public class SendCodeController {

  private static final int IP_MAX = 10;
  private static final String EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

  private final EmailCodeService codes;
  private final UserMapper users;
  private final Mailer mailer;
  private final LoginGuard guard;
  private final String nodeEnv;
  private final boolean trustProxy;

  public SendCodeController(EmailCodeService codes, UserMapper users,
      Mailer mailer, LoginGuard guard,
      @Value("${inkstack.node-env:development}") String nodeEnv,
      @Value("${inkstack.trust-proxy:0}") String trustProxy) {
    this.codes = codes;
    this.users = users;
    this.mailer = mailer;
    this.guard = guard;
    this.nodeEnv = nodeEnv;
    this.trustProxy = "1".equals(trustProxy);
  }

  public record Body(String email, String purpose) {}

  @PostMapping("/send-code")
  public ResponseEntity<Map<String, Object>> send(
      @RequestBody(required = false) Body body, HttpServletRequest request) {
    ClientMeta meta = ClientMeta.from(request, trustProxy);
    String ipKey = "sendcode-ip:" + meta.ip();
    LoginGuard.Verdict verdict = guard.verdict(ipKey, IP_MAX);
    if (verdict.locked()) {
      return ResponseEntity.status(429)
          .header(HttpHeaders.RETRY_AFTER, String.valueOf(verdict.retryAfterSec()))
          .body(Map.of("error", "操作过于频繁，请约 "
              + (long) Math.ceil(verdict.retryAfterSec() / 60.0) + " 分钟后再试"));
    }
    String raw = body == null || body.email() == null ? "" : body.email();
    String email = raw.trim().toLowerCase();
    String purpose = body == null ? "register" : switch (String.valueOf(body.purpose())) {
      case "reset" -> "reset";
      case "twofa" -> "twofa";
      default -> "register";
    };
    if (!email.matches(EMAIL_PATTERN)) {
      return ResponseEntity.badRequest().body(Map.of("error", "邮箱格式不正确"));
    }
    guard.hit(ipKey, IP_MAX);

    User existing = users.byEmailProbe(email);
    if ("reset".equals(purpose) && existing == null) {
      return ResponseEntity.status(404).body(Map.of("error", "该邮箱未注册"));
    }
    if ("twofa".equals(purpose)) {
      if (existing == null) {
        return ResponseEntity.status(404).body(Map.of("error", "该邮箱未注册"));
      }
      if (existing.getTotpEnabled() == null || existing.getTotpEnabled() != 1) {
        return ResponseEntity.badRequest()
            .body(Map.of("error", "该邮箱未开启两步验证，直接用密码登录即可"));
      }
    }
    if ("register".equals(purpose) && existing != null) {
      return ResponseEntity.status(409).body(Map.of("error", "该邮箱已注册，可直接登录"));
    }

    EmailCodeService.Issue issued;
    try {
      issued = codes.issue(email, purpose);
    } catch (RuntimeException e) {
      return ResponseEntity.status(500).body(Map.of("error", "发送失败，请稍后再试"));
    }
    if (!issued.ok()) {
      return ResponseEntity.status(429).body(Map.of("error", issued.error()));
    }
    Mailer.Result mail = mailer.sendVerifyCode(email, issued.code(), purpose);
    if (mail.error() != null) {
      return ResponseEntity.status(502).body(Map.of("error", mail.error()));
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    // 只在"非生产 + 未配 SMTP"时回显；生产即使漏配 SMTP 也不把验证码写进响应（v15.0）
    if (!"production".equals(nodeEnv) && !mailer.configured()) {
      out.put("devCode", issued.code());
      out.put("devHint", "SMTP 未配置，验证码已打印到服务端日志");
    }
    return ResponseEntity.ok(out);
  }
}
