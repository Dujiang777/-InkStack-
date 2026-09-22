package com.inkstack.notify;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.NodeShapes;
import com.inkstack.entity.CommunityRows;
import com.inkstack.mapper.CommunityMapper;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 站内信的读取与标记已读。
 *
 * <p>{@code body} / {@code link} 两列在 Node 侧是 {@code r.body ? String(r.body) : null}：
 * 空串也算假值，所以这里不能只判 null。
 */
@RestController
public class NotificationController {

  private final CommunityMapper db;

  public NotificationController(CommunityMapper db) {
    this.db = db;
  }

  @GetMapping("/api/notifications")
  public ResponseEntity<Map<String, Object>> list(@Current SessionUser me) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    try {
      List<CommunityRows.Notice> rows = db.notices(me.id());
      List<Map<String, Object>> items = new ArrayList<>();
      for (CommunityRows.Notice row : rows) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", NodeShapes.num(row.getId()));
        item.put("type", NodeShapes.text(row.getType()));
        item.put("title", NodeShapes.text(row.getTitle()));
        item.put("body", orNull(row.getBody()));
        item.put("link", orNull(row.getLink()));
        item.put("isRead", NodeShapes.num(row.getIsRead()) == 1);
        item.put("createdAt", NodeShapes.text(row.getCreatedAt()));
        items.add(item);
      }
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("notifications", items);
      body.put("unread", NodeShapes.num(db.unreadCount(me.id())));
      return ResponseEntity.ok(body);
    } catch (RuntimeException unreadable) {
      // 与 Node 的 catch 同姿势：通知读不出来就回空列表，不让小红点把页面打挂
      Map<String, Object> empty = new LinkedHashMap<>();
      empty.put("notifications", List.of());
      empty.put("unread", 0);
      return ResponseEntity.ok(empty);
    }
  }

  /** 传 id 只标记单条（且限本人，防越权改他人通知）；不传或非法则全部已读。 */
  @PostMapping("/api/notifications/read")
  public ResponseEntity<Map<String, Object>> read(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    JsonNode body = Bodies.json(request);
    long id = Bodies.positiveId(Bodies.text(body, "id"));
    try {
      if (id > 0) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("affected", db.markNoticeRead(id, me.id()));
        return ResponseEntity.ok(out);
      }
      db.markAllRead(me.id());
      return ResponseEntity.ok(Map.of("ok", true));
    } catch (RuntimeException failed) {
      return ResponseEntity.status(500).body(Map.of("ok", false));
    }
  }

  private static String orNull(String value) {
    return value == null || value.isEmpty() ? null : value;
  }
}
