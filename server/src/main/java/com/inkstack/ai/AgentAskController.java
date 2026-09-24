package com.inkstack.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.ai.AgentAskService.Reply;
import com.inkstack.ai.AgentAskService.Turn;
import com.inkstack.common.NodeShapes;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/**
 * {@code POST /api/agent/ask}。两种应答姿势必须分开：
 * 参数与鉴权类失败是<b>普通 JSON</b>（400/401/402，前端读 {@code error} 字段），
 * 一旦进入流式就只能是 NDJSON 帧（包括"上游半路炸了"那种 error 帧）——
 * 流已经开始就不可能再把状态码改掉，这是 HTTP 的限制，不是实现取舍。
 */
@RestController
public class AgentAskController {

  /** Node 那边是 {@code "application/x-ndjson; charset=utf-8"}，逐字对上才不算换入口改了契约。 */
  private static final MediaType NDJSON = MediaType.parseMediaType("application/x-ndjson; charset=utf-8");

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private final AgentAskService agent;

  public AgentAskController(AgentAskService agent) {
    this.agent = agent;
  }

  /**
   * 返回类型必须<b>字面</b>写成 {@code ResponseEntity<StreamingResponseBody>}：Spring 是按
   * **声明的**泛型参数决定走不走流式处理器，写成 {@code ResponseEntity<?>} 时那条通配不算数，
   * 于是流式体被当成普通返回值去找 JSON 转换器，报 "No converter for …Lambda…" → 500。
   * 而这条链路的扣款在返回之前就完成了，所以这个 500 的形态是"钱扣了、一个字都没给读者"——
   * 闸门里专门有一句盯住它。
   */
  @PostMapping("/api/agent/ask")
  public ResponseEntity<StreamingResponseBody> ask(
      @Current SessionUser me, HttpServletRequest request) {
    JsonNode body = Bodies.json(request);
    // 三个字符串入参都按 String() 收口：与 Node 同一口径，数字/数组不会把 trim 打成 500
    String question = NodeShapes.slice(NodeShapes.jsTrim(coerce(body, "question", "")), 500);
    String author = NodeShapes.slice(NodeShapes.jsTrim(coerce(body, "author", "博主")), 40);
    String about = NodeShapes.slice(NodeShapes.jsTrim(coerce(body, "about", "")), 120);
    Reply reply = agent.ask(me == null ? null : me.id(), question, author, about, history(body));
    if (reply instanceof Reply.Status status) {
      // 参数与鉴权类失败仍是一条普通 JSON（前端读 error 字段），不是流里的一帧
      byte[] payload = jsonBytes(status.body());
      return ResponseEntity.status(status.code())
          .contentType(MediaType.APPLICATION_JSON)
          .body(out -> out.write(payload));
    }
    AgentAskService.StreamBody stream = ((Reply.Stream) reply).body();
    return ResponseEntity.ok()
        .contentType(NDJSON)
        .header("Cache-Control", "no-cache, no-transform")
        .body(out -> {
          try {
            stream.write(out);
          } catch (Exception broken) {
            // 流已经开始了，状态码改不了，能做的只有把连接收掉——Node 那边的
            // try/catch/finally { controller.close() } 是同一个姿势。异常本身不外泄给读者。
          }
        });
  }

  private static byte[] jsonBytes(Map<String, Object> body) {
    try {
      return MAPPER.writeValueAsBytes(body);
    } catch (Exception impossible) {
      return "{\"error\":\"服务异常\"}".getBytes(StandardCharsets.UTF_8);
    }
  }

  /** {@code (body.x ?? 默认值)} 之后一律 String()：缺键与显式 null 走默认，其余收成 JS 的字符串形状。 */
  private static String coerce(JsonNode body, String field, String fallback) {
    JsonNode value = body.get(field);
    if (value == null || value.isNull()) {
      return fallback;
    }
    return value.isTextual() ? value.asText() : Bodies.stringOf(value);
  }

  /**
   * 多轮记忆：只留最近 6 条<b>有效</b>发言（角色须为 user / agent、文本是非空字符串），
   * 每条裁到 600 字。角色 "agent" 在发给模型时改名 "assistant"，这是 Node 的映射。
   */
  private static List<Turn> history(JsonNode body) {
    JsonNode list = body.get("history");
    if (list == null || !list.isArray()) {
      return List.of();
    }
    List<Turn> kept = new ArrayList<>();
    for (JsonNode turn : list) {
      if (turn == null || !turn.isObject()) {
        continue;
      }
      String role = turn.path("role").isTextual() ? turn.path("role").asText() : null;
      JsonNode text = turn.get("text");
      if (!"user".equals(role) && !"agent".equals(role)) {
        continue;
      }
      if (text == null || !text.isTextual() || NodeShapes.jsTrim(text.asText()).isEmpty()) {
        continue;
      }
      kept.add(new Turn("user".equals(role) ? "user" : "assistant",
          NodeShapes.slice(text.asText(), 600)));
    }
    // slice(-6)：不足 6 条时从头开始，而不是补空
    return kept.size() <= 6 ? kept : new ArrayList<>(kept.subList(kept.size() - 6, kept.size()));
  }
}
