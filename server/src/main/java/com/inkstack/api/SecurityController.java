package com.inkstack.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.auth.LoginGuard;
import com.inkstack.auth.PasswordHasher;
import com.inkstack.auth.Totp;
import com.inkstack.common.PwnedPasswords;
import com.inkstack.entity.SessionRow;
import com.inkstack.entity.User;
import com.inkstack.common.NodeShapes;
import com.inkstack.mapper.AuditMapper;
import com.inkstack.mapper.SessionMapper;
import com.inkstack.mapper.UserMapper;
import com.inkstack.session.SessionService;
import com.inkstack.session.SessionUser;
import com.inkstack.web.ClientMeta;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 安全中心三组接口：改密 / 设备管理 / 两步验证。与 app/api/security/* 逐分支对齐。
 *
 * <p>两条共同约束：身份只认签名 Cookie（不接受外部传 userId），以及<b>失败计数走
 * hit-then-lock</b>（第 5 次当场就锁，而不是第 6 次才锁）。改密、2FA 开关都是"拿到会话后可以
 * 试着把账号交出去"的动作，限流键里都带 uid+ip，避免单点爆破。
 *
 * <p>改密与重置的差别是刻意的：改密<b>保留当前会话</b>（revokeOthers），重置<b>全部下线</b>
 * （revokeAllForUser）——前者是主人在自己设备上换密码，后者意味着凭据已泄露。
 */
@RestController
@RequestMapping("/api/security")
public class SecurityController {

  private final UserMapper users;
  private final SessionMapper sessions;
  private final AuditMapper audit;
  private final SessionService sessionService;
  private final LoginGuard guard;
  private final PwnedPasswords pwned;
  private final boolean trustProxy;
  private final ObjectMapper json = new ObjectMapper();

  public SecurityController(UserMapper users, SessionMapper sessions, AuditMapper audit,
      SessionService sessionService, LoginGuard guard, PwnedPasswords pwned,
      @Value("${inkstack.trust-proxy:0}") String trustProxy) {
    this.users = users;
    this.sessions = sessions;
    this.audit = audit;
    this.sessionService = sessionService;
    this.guard = guard;
    this.pwned = pwned;
    this.trustProxy = "1".equals(trustProxy);
  }

  private static final ResponseEntity<Map<String, Object>> NEED_LOGIN =
      ResponseEntity.status(401).body(Map.of("error", "请先登录"));
  private static final String PW_RULE = "至少 8 位，且需同时包含字母和数字";

  private static boolean weak(String pw) {
    return pw.length() < 8 || !pw.matches(".*[a-zA-Z].*") || !pw.matches(".*[0-9].*");
  }

  private void audit(String event, long uid, ClientMeta meta, String detail) {
    try {
      this.audit.insert(uid, event, meta.ipOrNull(), meta.uaOrNull(), detail);
    } catch (RuntimeException ignored) {
      // 审计失败不阻塞主流程
    }
  }

  private static ResponseEntity<Map<String, Object>> tooFrequent() {
    return ResponseEntity.status(429).body(Map.of("error", "尝试过于频繁，请 15 分钟后再试"));
  }

  public record PasswordBody(String oldPassword, String newPassword) {}

  @PostMapping("/password")
  public ResponseEntity<Map<String, Object>> password(@Current SessionUser me,
      @RequestBody(required = false) PasswordBody body, HttpServletRequest request) {
    if (me == null) {
      return NEED_LOGIN;
    }
    ClientMeta meta = ClientMeta.from(request, trustProxy);
    String key = "pwdchg:" + me.id() + ":" + meta.ip();
    if (guard.verdict(key).locked()) {
      return tooFrequent();
    }
    String oldPw = body == null || body.oldPassword() == null ? "" : body.oldPassword();
    String newPw = body == null || body.newPassword() == null ? "" : body.newPassword();
    if (weak(newPw)) {
      return ResponseEntity.badRequest().body(Map.of("error", "新密码" + PW_RULE));
    }
    User u = users.byIdForSecurity(me.id());
    if (u == null || !PasswordHasher.verify(oldPw, u.getPasswordHash())) {
      LoginGuard.Verdict after = guard.hit(key);
      audit("password_change", me.id(), meta, "旧密码错误");
      return ResponseEntity.status(401).body(Map.of("error",
          "旧密码不正确（还可尝试 " + after.remaining() + " 次）"));
    }
    guard.clear(key);
    int leaked = pwned.count(newPw);
    if (leaked > 0) {
      return ResponseEntity.badRequest().body(Map.of("error",
          "新密码已出现在 " + leaked + " 次已知泄露中，请换一个"));
    }
    users.replacePassword(me.id(), PasswordHasher.hash(newPw));
    String currentHash = sessionService.currentTokenHash(request).orElse("");
    int revoked = sessions.revokeOthers(me.id(), currentHash);
    audit("password_change", me.id(), meta, "成功，下线 " + revoked + " 台其他设备");
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("revoked", revoked);
    out.put("hint", revoked > 0 ? "已下线其他 " + revoked + " 台设备" : "密码已更新");
    return ResponseEntity.ok(out);
  }

  /** 会话列表：键名沿用 Node 的 snake_case（前端类型就是这么写的），时间统一 ISO。 */
  @GetMapping("/sessions")
  public ResponseEntity<Map<String, Object>> sessions(@Current SessionUser me,
      HttpServletRequest request) {
    if (me == null) {
      return NEED_LOGIN;
    }
    String currentHash = sessionService.currentTokenHash(request).orElse("");
    List<Map<String, Object>> rows = new ArrayList<>();
    for (SessionRow row : sessions.listActive(me.id())) {
      Map<String, Object> item = new LinkedHashMap<>();
      item.put("id", row.getId());
      item.put("ua", row.getUa());
      item.put("ip", row.getIp());
      item.put("created_at", NodeShapes.iso(row.getCreatedAt()));
      item.put("last_seen_at", NodeShapes.iso(row.getLastSeenAt()));
      item.put("current", currentHash.equals(row.getTokenHash()));
      rows.add(item);
    }
    return ResponseEntity.ok(Map.of("ok", true, "sessions", rows));
  }

  public record RevokeBody(Long id, Boolean all) {}

  @DeleteMapping("/sessions")
  public ResponseEntity<Map<String, Object>> revoke(@Current SessionUser me,
      @RequestBody(required = false) RevokeBody body, HttpServletRequest request) {
    if (me == null) {
      return NEED_LOGIN;
    }
    ClientMeta meta = ClientMeta.from(request, trustProxy);
    if (body != null && Boolean.TRUE.equals(body.all())) {
      String currentHash = sessionService.currentTokenHash(request).orElse("");
      int revoked = sessions.revokeOthers(me.id(), currentHash);
      audit("session_revoke", me.id(), meta, "下线其他 " + revoked + " 台设备");
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("ok", true);
      out.put("revoked", revoked);
      out.put("hint", revoked > 0 ? "已下线其他 " + revoked + " 台设备" : "没有其他在线设备");
      return ResponseEntity.ok(out);
    }
    if (body != null && body.id() != null) {
      if (sessions.revokeOneOf(body.id(), me.id()) == 0) {
        return ResponseEntity.status(404).body(Map.of("error", "会话不存在或已下线"));
      }
      audit("session_revoke", me.id(), meta, "下线会话 #" + body.id());
      return ResponseEntity.ok(Map.of("ok", true));
    }
    return ResponseEntity.badRequest().body(Map.of("error", "参数错误：需要 id 或 all"));
  }

  @PostMapping("/2fa")
  public ResponseEntity<Map<String, Object>> stage(@Current SessionUser me) {
    if (me == null) {
      return NEED_LOGIN;
    }
    User u = users.byIdForSecurity(me.id());
    if (u == null) {
      return ResponseEntity.status(404).body(Map.of("error", "用户不存在"));
    }
    if (u.getTotpEnabled() != null && u.getTotpEnabled() == 1) {
      return ResponseEntity.badRequest()
          .body(Map.of("error", "两步验证已开启，如需重置请先关闭"));
    }
    String secret = Totp.generateSecret();
    users.stageTotpSecret(me.id(), secret);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("secret", secret);
    out.put("otpauth", Totp.otpauthUrl(secret, u.getEmail()));
    out.put("hint", "用验证器 App 扫码或手动输入密钥，然后输入 6 位验证码完成开启");
    return ResponseEntity.ok(out);
  }

  public record CodeBody(String code) {}

  @PutMapping("/2fa")
  public ResponseEntity<Map<String, Object>> enable(@Current SessionUser me,
      @RequestBody(required = false) CodeBody body, HttpServletRequest request) {
    if (me == null) {
      return NEED_LOGIN;
    }
    ClientMeta meta = ClientMeta.from(request, trustProxy);
    String key = "2fa-setup:" + me.id() + ":" + meta.ip();
    if (guard.verdict(key).locked()) {
      return tooFrequent();
    }
    String code = body == null || body.code() == null ? "" : body.code().trim();
    User u = users.byIdForSecurity(me.id());
    if (u == null || u.getTotpSecret() == null || u.getTotpSecret().isBlank()) {
      return ResponseEntity.badRequest().body(Map.of("error", "请先生成密钥（第一步）"));
    }
    if (u.getTotpEnabled() != null && u.getTotpEnabled() == 1) {
      return ResponseEntity.badRequest().body(Map.of("error", "两步验证已开启"));
    }
    if (!Totp.verify(u.getTotpSecret(), code)) {
      LoginGuard.Verdict after = guard.hit(key);
      return ResponseEntity.status(401).body(Map.of("error",
          "验证码不正确（还可尝试 " + after.remaining() + " 次）"));
    }
    guard.clear(key);
    Totp.BackupCodes generated = Totp.generateBackupCodes();
    users.commitTotp(me.id(), writeJson(generated.hashed()));
    audit("totp_enable", me.id(), meta, null);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("backupCodes", generated.plain());
    out.put("hint", "两步验证已开启！备份码仅显示这一次，请抄写在安全的地方");
    return ResponseEntity.ok(out);
  }

  public record DisableBody(String password, String code) {}

  @DeleteMapping("/2fa")
  public ResponseEntity<Map<String, Object>> disable(@Current SessionUser me,
      @RequestBody(required = false) DisableBody body, HttpServletRequest request) {
    if (me == null) {
      return NEED_LOGIN;
    }
    ClientMeta meta = ClientMeta.from(request, trustProxy);
    String key = "2fa-off:" + me.id() + ":" + meta.ip();
    if (guard.verdict(key).locked()) {
      return tooFrequent();
    }
    User u = users.byIdForSecurity(me.id());
    if (u == null) {
      return ResponseEntity.status(404).body(Map.of("error", "用户不存在"));
    }
    if (u.getTotpEnabled() == null || u.getTotpEnabled() != 1) {
      return ResponseEntity.badRequest().body(Map.of("error", "两步验证未开启"));
    }
    if (!PasswordHasher.verify(body == null ? "" : nullSafe(body.password()), u.getPasswordHash())) {
      LoginGuard.Verdict after = guard.hit(key);
      return ResponseEntity.status(401).body(Map.of("error",
          "密码不正确（还可尝试 " + after.remaining() + " 次）"));
    }
    if (!Totp.verify(u.getTotpSecret(), body == null ? "" : nullSafe(body.code()))) {
      LoginGuard.Verdict after = guard.hit(key);
      return ResponseEntity.status(401).body(Map.of("error",
          "验证码不正确（还可尝试 " + after.remaining() + " 次）"));
    }
    guard.clear(key);
    users.clearTotp(me.id());
    audit("totp_disable", me.id(), meta, null);
    return ResponseEntity.ok(Map.of("ok", true, "hint", "两步验证已关闭"));
  }

  private static String nullSafe(String value) {
    return value == null ? "" : value;
  }

  private String writeJson(List<String> values) {
    try {
      return json.writeValueAsString(values);
    } catch (Exception e) {
      throw new IllegalStateException("备份码序列化失败", e);
    }
  }
}
