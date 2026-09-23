package com.inkstack.study;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.NodeShapes;
import com.inkstack.entity.StudyRows;
import com.inkstack.mapper.StudyMapper;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 草稿箱读写（创作台自动保存 / 回填）。
 *
 * <p>{@code savedAt} 回的是<b>应用侧时钟</b>，不是库里的 {@code updated_at}：Node 用
 * {@code new Date().toLocaleTimeString("zh-CN", {hour12:false})}，前端拿它是为了立刻显示"已保存 13:26:52"，
 * 等一次 round-trip 反而慢。格式必须是 {@code HH:mm:ss}（Node 22 的 ICU 在 zh-CN + hour12:false
 * 下走 h23 周期，零点渲染成 00:xx:xx 而不是 24:xx:xx）。
 */
@RestController
public class DraftController {

  private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm:ss");
  private static final int TITLE_MAX = 200;
  private static final int CONTENT_MAX = 100_000;

  private final StudyMapper db;

  public DraftController(StudyMapper db) {
    this.db = db;
  }

  @GetMapping("/api/drafts")
  public ResponseEntity<Map<String, Object>> read(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "未登录，草稿将暂存本地"));
    }
    // Node：searchParams.get("title")?.slice(0,200) || "" —— 判空前先裁 200，且不 trim
    String raw = request.getParameter("title");
    String title = raw == null ? "" : NodeShapes.slice(raw, TITLE_MAX);
    if (title.isEmpty()) {
      return empty();
    }
    StudyRows.Draft row;
    try {
      row = db.draft(me.id(), title);
    } catch (RuntimeException failed) {
      return ResponseEntity.status(500).body(Map.of("error", "草稿读取失败"));
    }
    if (row == null) {
      return empty();
    }
    Map<String, Object> draft = new LinkedHashMap<>();
    draft.put("content", NodeShapes.text(row.getContent()));
    draft.put("updatedAt", NodeShapes.text(row.getUpdatedAt()));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("draft", draft);
    return ResponseEntity.ok(out);
  }

  @PutMapping("/api/drafts")
  public ResponseEntity<Map<String, Object>> save(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "未登录，草稿将暂存本地"));
    }
    JsonNode body = Bodies.json(request);
    String title = NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(body, "title")), TITLE_MAX);
    String content = Bodies.text(body, "content");
    if (title.isEmpty()) {
      return ResponseEntity.badRequest().body(Map.of("error", "title 不能为空"));
    }
    if (content.length() > CONTENT_MAX) {
      return ResponseEntity.badRequest().body(Map.of("error", "草稿过长（上限 10 万字）"));
    }
    try {
      db.upsertDraft(me.id(), title, content);
    } catch (RuntimeException failed) {
      return ResponseEntity.status(500).body(Map.of("error", "草稿保存失败"));
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("savedAt", LocalTime.now().format(CLOCK));
    return ResponseEntity.ok(out);
  }

  /** {@code {draft: null}} 必须是显式的 null 值，不能是"没有 draft 键"。 */
  private static ResponseEntity<Map<String, Object>> empty() {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("draft", null);
    return ResponseEntity.ok(out);
  }
}
