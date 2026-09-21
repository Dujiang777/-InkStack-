package com.inkstack.auth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.common.Hex;
import com.inkstack.entity.User;
import com.inkstack.mail.Mailer;
import com.inkstack.mapper.AuditMapper;
import com.inkstack.mapper.SessionMapper;
import com.inkstack.mapper.UserMapper;
import com.inkstack.session.SessionService;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.HttpServletResponse;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 邮箱密码登录，流程与 app/api/auth/login/route.ts 逐步对齐：
 * 先查锁（不透露账号是否存在）→ 验密 → 2FA → 清计数 → 设备判定 → 签发会话 → 审计。
 */
@Service
public class LoginService {

  private static final Logger log = LoggerFactory.getLogger(LoginService.class);

  private final UserMapper users;
  private final SessionMapper sessions;
  private final AuditMapper audit;
  private final SessionService sessionService;
  private final LoginGuard guard;
  private final Mailer mailer;
  private final ObjectMapper mapper = new ObjectMapper();

  public LoginService(
      UserMapper users,
      SessionMapper sessions,
      AuditMapper audit,
      SessionService sessionService,
      LoginGuard guard,
      Mailer mailer) {
    this.users = users;
    this.sessions = sessions;
    this.audit = audit;
    this.sessionService = sessionService;
    this.guard = guard;
    this.mailer = mailer;
  }

  public LoginResult login(String rawEmail, String password, String rawTotp, ClientMeta meta,
      HttpServletResponse response) {
    String email = rawEmail == null ? "" : rawEmail.trim().toLowerCase();
    String totp = rawTotp == null ? "" : rawTotp.trim();
    String key = "login:" + email + ":" + meta.ip();

    LoginGuard.Verdict before = guard.verdict(key);
    if (before.locked()) {
      return new LoginResult.Locked(
          "尝试次数过多，账号已临时锁定，请约 " + (long) Math.ceil(before.retryAfterSec() / 60.0) + " 分钟后再试",
          before.retryAfterSec());
    }

    User user = users.findByLoginEmail(email);
    if (user == null || !PasswordHasher.verify(password == null ? "" : password, user.getPasswordHash())) {
      LoginGuard.Verdict after = guard.hit(key);
      audit("login_fail", user == null ? null : user.getId(), meta, "密码错误: " + email);
      return new LoginResult.Denied("邮箱或密码不正确" + hint(after), false);
    }

    if (isEnabled(user.getTotpEnabled()) && user.getTotpSecret() != null) {
      if (totp.isEmpty()) {
        // 密码正确但缺码：不记失败、不发码，让前端进第二段。
        return new LoginResult.Need2fa(email);
      }
      String failure = secondFactor(user, totp, meta);
      if (failure != null) {
        LoginGuard.Verdict after = guard.hit(key);
        audit("login_2fa", user.getId(), meta, failure);
        return new LoginResult.Denied("两步验证码不正确" + hint(after), true);
      }
    }

    guard.clear(key);
    boolean newDevice = sessions.countActiveByUa(user.getId(), meta.userAgent()) == 0;
    sessionService.issue(user.getId(), meta, response);
    audit("login_ok", user.getId(), meta, null);
    if (newDevice) {
      // 新设备提醒：异步发、失败静默——一封提醒邮件绝不能把登录本身拖失败。
      String time = ZonedDateTime.now(ZoneId.of("Asia/Shanghai"))
          .format(DateTimeFormatter.ofPattern("yyyy/M/d HH:mm:ss", Locale.CHINA));
      String mailTo = user.getEmail();
      Mailer sender = this.mailer;
      CompletableFuture.runAsync(() -> sender.sendLoginAlert(mailTo, meta.ip(), meta.userAgent(), time));
      log.info("新设备登录 uid={} ip={} ua={}", user.getId(), meta.ip(), meta.userAgent());
    }
    return new LoginResult.Success(user.getId(), user.getNickname());
  }

  /** 返回 null 表示二段通过；否则返回用于审计与分支的失败标识。 */
  private String secondFactor(User user, String code, ClientMeta meta) {
    if (Totp.verify(user.getTotpSecret(), code)) {
      return null;
    }
    if (consumeBackupCode(user, code, meta)) {
      return null;
    }
    return "验证码错误";
  }

  /** 一次性备份码命中即焚：库里存的是 sha256 hex 数组，比对前先按原实现大写归一。 */
  private boolean consumeBackupCode(User user, String code, ClientMeta meta) {
    if (user.getTotpBackup() == null || user.getTotpBackup().isBlank()) {
      return false;
    }
    List<String> hashed;
    try {
      hashed = mapper.readValue(user.getTotpBackup(), new TypeReference<List<String>>() {});
    } catch (Exception malformed) {
      hashed = List.of();
    }
    String target = Hex.sha256Hex(code.toUpperCase());
    if (!hashed.contains(target)) {
      return false;
    }
    try {
      users.replaceTotpBackup(
          user.getId(),
          mapper.writeValueAsString(hashed.stream().filter(h -> !h.equals(target)).toList()));
      audit("login_2fa", user.getId(), meta, "备份码登录（已焚毁 1 枚）");
    } catch (Exception e) {
      log.warn("备份码焚毁写入失败：{}", e.getMessage());
    }
    return true;
  }

  private static String hint(LoginGuard.Verdict after) {
    return after.locked() ? "，账号已临时锁定 15 分钟" : "（还可尝试 " + after.remaining() + " 次）";
  }

  private static boolean isEnabled(Integer flag) {
    return flag != null && flag == 1;
  }

  private void audit(String event, Long uid, ClientMeta meta, String detail) {
    try {
      audit.insert(uid, event, meta.ipOrNull(), meta.uaOrNull(), detail);
    } catch (RuntimeException e) {
      log.warn("审计写入失败 event={}：{}", event, e.getMessage());
    }
  }
}
