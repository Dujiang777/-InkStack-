package com.inkstack.study;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.NodeShapes;
import com.inkstack.mapper.StudyMapper;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 阅读足迹上报。
 *
 * <p>游客一律 {@code {ok:true, skipped:true}} 而不是 401：这条是"顺手记一笔"的埋点，
 * 文章页对游客也要发，回 401 只会在控制台里制造噪音。
 * 落库失败同样静默——足迹不是关键路径，宁可少一条记录也不能把阅读打断。
 */
@RestController
public class HistoryController {

  private final StudyMapper db;

  public HistoryController(StudyMapper db) {
    this.db = db;
  }

  @PostMapping("/api/history")
  public ResponseEntity<Map<String, Object>> report(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.ok(Map.of("ok", true, "skipped", true));
    }
    JsonNode body = Bodies.json(request);
    JsonNode slug = body.get("slug");
    // Node 判的是 typeof === "string"：数字、对象一律当"没传"，回 400 而不是 500
    String value = slug != null && slug.isTextual() ? NodeShapes.jsTrim(slug.asText()) : "";
    if (value.isEmpty() || value.length() > 200) {
      return ResponseEntity.badRequest().body(Map.of("error", "参数无效"));
    }
    try {
      db.recordRead(me.id(), value);
    } catch (RuntimeException ignored) {
      // 与 Node 同样静默
    }
    return ResponseEntity.ok(Map.of("ok", true));
  }
}
