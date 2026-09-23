package com.inkstack.auth;

import com.inkstack.common.PwnedPasswords;
import com.inkstack.entity.User;
import com.inkstack.mapper.AuditMapper;
import com.inkstack.mapper.SessionMapper;
import com.inkstack.mapper.UserMapper;
import com.inkstack.session.SessionService;
import com.inkstack.web.ClientMeta;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * 改密的同一条流程，两个入口共用：{@code POST /api/security/password}（安全中心）与
 * {@code PATCH /api/me/password}（书房设置）。
 *
 * <p>之所以抽出来而不是各写一遍：这条链路上有五处"少一处就出事"的环节——旧密码爆破限流、
 * 强度门槛、泄露库检查、改后下线其他设备、审计落账。两处各存一份副本，早晚会有一处被改而另一处忘了跟上，
 * 而那正是"安全策略看着在、其实只对半个站点生效"的形态。
 *
 * <p>两个入口的差异只有三处，全是历史形成的接口契约，换栈期原样照搬（改它们属于契约变更）：
 * <ol>
 *   <li>书房入口多一条"新密码不能与旧密码相同"；</li>
 *   <li>泄露库提示书房入口多一句"（建议加符号或更长）"；</li>
 *   <li>成功响应安全中心多回一个 {@code hint}，书房只回 {@code {ok, revoked}}。</li>
 * </ol>
 */
@Service
public class PasswordChangeService {

  /** 一次改密的终态：状态码 + 响应体。 */
  public record Outcome(int status, Map<String, Object> body) {

    static Outcome of(int status, String error) {
      return new Outcome(status, Map.of("error", error));
    }
  }

  private static final String PW_RULE = "至少 8 位，且需同时包含字母和数字";

  private final UserMapper users;
  private final SessionMapper sessions;
  private final AuditMapper audit;
  private final SessionService sessionService;
  private final LoginGuard guard;
  private final PwnedPasswords pwned;
  private final boolean trustProxy;

  public PasswordChangeService(UserMapper users, SessionMapper sessions, AuditMapper audit,
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

  /** {@code meVariant} = 书房入口（PATCH /api/me/password）。 */
  public Outcome change(long uid, String oldPw, String newPw, boolean meVariant,
      HttpServletRequest request) {
    ClientMeta meta = ClientMeta.from(request, trustProxy);
    String key = "pwdchg:" + uid + ":" + meta.ip();
    if (guard.verdict(key).locked()) {
      return Outcome.of(429, "尝试过于频繁，请 15 分钟后再试");
    }
    if (newPw.length() < 8 || !newPw.matches(".*[a-zA-Z].*") || !newPw.matches(".*[0-9].*")) {
      return Outcome.of(400, "新密码" + PW_RULE);
    }
    if (meVariant && newPw.equals(oldPw)) {
      return Outcome.of(400, "新密码不能与旧密码相同");
    }
    User u;
    try {
      u = users.byIdForSecurity(uid);
      if (u == null || !PasswordHasher.verify(oldPw, u.getPasswordHash())) {
        LoginGuard.Verdict after = guard.hit(key);
        log("password_change", uid, meta, "旧密码错误");
        return Outcome.of(401, "旧密码不正确（还可尝试 " + after.remaining() + " 次）");
      }
      guard.clear(key);
      int leaked = pwned.count(newPw);
      if (leaked > 0) {
        return Outcome.of(400, "新密码已出现在 " + leaked + " 次已知泄露中，请换一个"
            + (meVariant ? "（建议加符号或更长）" : ""));
      }
      users.replacePassword(uid, PasswordHasher.hash(newPw));
      int revoked = sessions.revokeOthers(uid, currentHash(request));
      log("password_change", uid, meta, "成功，下线 " + revoked + " 台其他设备");
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("ok", true);
      out.put("revoked", revoked);
      if (!meVariant) {
        out.put("hint", revoked > 0 ? "已下线其他 " + revoked + " 台设备" : "密码已更新");
      }
      return new Outcome(200, out);
    } catch (RuntimeException failed) {
      return Outcome.of(500, meVariant ? "修改失败（数据库异常）" : "操作失败，请稍后再试");
    }
  }

  private String currentHash(HttpServletRequest request) {
    return sessionService.currentTokenHash(request).orElse("");
  }

  private void log(String event, long uid, ClientMeta meta, String detail) {
    try {
      audit.insert(uid, event, meta.ipOrNull(), meta.uaOrNull(), detail);
    } catch (RuntimeException ignored) {
      // 审计失败不阻塞主流程
    }
  }
}
