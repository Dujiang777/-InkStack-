package com.inkstack.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/ai/write}。坏 JSON 与缺字段都退化成空对象（Node 的
 * {@code req.json().catch(() => ({}))}），最终由 mode 校验给出那条 400——
 * 与书房那批"坏 JSON 另有一条文案"的接口不是同一种姿势，别顺手统一。
 */
@RestController
public class AiWriteController {

  private final AiWriteService writer;

  public AiWriteController(AiWriteService writer) {
    this.writer = writer;
  }

  @PostMapping("/api/ai/write")
  public ResponseEntity<Map<String, Object>> write(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "登录后才能使用 AI 写作助手"));
    }
    JsonNode body = Bodies.json(request);
    // mode 走 String() 口径：Node 的 LABELS[body.mode ?? ""] 对数字键会强转成字符串再查，
    // 传 {"mode":5} 与 {"mode":"5"} 是同一个查询结果，标量不能在这里被丢掉。
    AiWriteService.Outcome outcome = writer.write(
        me.id(), stringOf(body, "mode"), stringOf(body, "draft"), authorOf(body));
    return ResponseEntity.status(outcome.status()).body(outcome.body());
  }

  /** {@code body.draft ?? ""}：显式 null 与没传都是空串，非标量按 String() 转。 */
  private static String stringOf(JsonNode body, String field) {
    JsonNode value = body.get(field);
    if (value == null || value.isNull()) {
      return "";
    }
    return value.isTextual() ? value.asText() : Bodies.stringOf(value);
  }

  /**
   * author 与 draft 的兜底不一样：Node 是 {@code (body.author ?? "博主").trim()}，
   * 只有<b>没传或传 null</b>才给"博主"，传空串就是空串。所以这里必须把"缺席"如实报成 null，
   * 而不是和空串混成一回事——混掉的表现为上游收到的署名是空，而不是"博主"。
   */
  private static String authorOf(JsonNode body) {
    JsonNode value = body.get("author");
    if (value == null || value.isNull()) {
      return null;
    }
    return value.isTextual() ? value.asText() : Bodies.stringOf(value);
  }
}
