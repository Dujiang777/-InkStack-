package com.inkstack.user;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.auth.PasswordChangeService;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code PATCH /api/me/password} —— 书房设置里的改密入口。
 *
 * <p>与安全中心那条共用 {@link PasswordChangeService}：两条链路上的强度门槛、爆破限流、
 * 泄露库检查、"改完下线其他设备"必须一处改、两处生效。
 */
@RestController
public class MePasswordController {

  private final PasswordChangeService passwords;

  public MePasswordController(PasswordChangeService passwords) {
    this.passwords = passwords;
  }

  @PatchMapping("/api/me/password")
  public ResponseEntity<Map<String, Object>> password(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    JsonNode body = Bodies.json(request);
    String oldPw = Bodies.text(body, "oldPassword");
    String newPw = Bodies.text(body, "newPassword");
    PasswordChangeService.Outcome outcome = passwords.change(me.id(), oldPw, newPw, true, request);
    return ResponseEntity.status(outcome.status()).body(outcome.body());
  }
}
