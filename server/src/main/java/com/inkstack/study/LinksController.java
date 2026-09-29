package com.inkstack.study;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.Links;
import com.inkstack.common.NodeShapes;
import com.inkstack.entity.StudyRows;
import com.inkstack.mapper.StudyMapper;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 外链审核：创作台插入外链时自动投递，运营在后台放行。
 *
 * <p>POST 要登录是 v17.2 补的闸：原先匿名可投，域名唯一键只防重复域名，换个域名就能无限灌审核队列。
 * GET/PUT 是运营动作，<b>未登录也回 403 而不是 401</b>——这条与全站其它门禁不同，
 * 是 Node 原样如此，双轨期照搬（改成一致属于接口契约变更，不在换栈范围内）。
 */
@RestController
public class LinksController {

  private static final String SUBMITTED = "已提交审核，通过前该链接将以「待审核」样式展示";

  private final StudyMapper db;

  public LinksController(StudyMapper db) {
    this.db = db;
  }

  @PostMapping("/api/links")
  public ResponseEntity<Map<String, Object>> submit(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "登录后才能提交外链审核"));
    }
    JsonNode body = Bodies.json(request);
    String url = NodeShapes.jsTrim(Bodies.text(body, "url"));
    String domain = Links.domain(url);
    if (domain.isEmpty()) {
      return ResponseEntity.badRequest().body(Map.of("error", "url 无效"));
    }
    try {
      db.submitLink(domain, NodeShapes.slice(url, 500),
          NodeShapes.slice(Bodies.text(body, "note"), 200));
    } catch (RuntimeException ignored) {
      // 审核库不可用时不阻塞创作台，与 Node 的静默一致
    }
    return ResponseEntity.ok(Map.of("ok", true, "message", SUBMITTED));
  }

  @GetMapping("/api/links")
  public ResponseEntity<Map<String, Object>> list(@Current SessionUser me) {
    if (me == null || !me.isStaff()) {
      return ResponseEntity.status(403).body(Map.of("error", "仅管理员可查看"));
    }
    List<Map<String, Object>> rows = new ArrayList<>();
    for (StudyRows.Link link : db.listLinks()) {
      Map<String, Object> item = new java.util.LinkedHashMap<>();
      item.put("id", NodeShapes.num(link.getId()));
      item.put("domain", NodeShapes.text(link.getDomain()));
      item.put("url", NodeShapes.text(link.getUrl()));
      item.put("note", NodeShapes.text(link.getNote()));
      item.put("status", NodeShapes.text(link.getStatus()));
      item.put("createdAt", NodeShapes.text(link.getCreatedAt()));
      rows.add(item);
    }
    return ResponseEntity.ok(Map.of("links", rows));
  }

  /**
   * 渲染层要的那份放行域名清单（P7f-1f-b）。
   *
   * <p>它与上面那条 {@code GET /api/links} 是两件事：那条是运营台的审核队列（带 url 与备注、
   * 非运营 403），这条只回答"这个域名能不能直接点开"，游客渲染文章时也要用它，所以必须公开。
   * 内容也不重合——只回 {@code approved} 的域名本身。
   *
   * <p>{@code lib/link-policy.ts} 里那份 {@code DEFAULT_ALLOW}（十几个代码/文档站）留在 Next 侧：
   * 它是展示层的默认审美，不是库里的数据；两栈各留各的那一半，合并发生在页面那一侧。
   */
  @GetMapping("/api/links/allowed-domains")
  public ResponseEntity<Map<String, Object>> allowedDomains() {
    List<String> domains = new ArrayList<>();
    for (String d : db.approvedDomains()) {
      if (d != null && !d.isBlank()) {
        domains.add(d.toLowerCase());
      }
    }
    return ResponseEntity.ok(Map.of("domains", domains));
  }

  @PutMapping("/api/links")
  public ResponseEntity<Map<String, Object>> review(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null || !me.isStaff()) {
      return ResponseEntity.status(403).body(Map.of("error", "仅管理员可审核"));
    }
    JsonNode body = Bodies.json(request);
    String action = Bodies.text(body, "action");
    if (!isTruthy(body.get("id")) || !(action.equals("approve") || action.equals("reject"))) {
      return ResponseEntity.badRequest().body(Map.of("error", "参数：id + action(approve|reject)"));
    }
    db.reviewLink((long) Bodies.number(body, "id"), action.equals("approve") ? "approved" : "rejected");
    return ResponseEntity.ok(Map.of("ok", true));
  }

  /** JS 的真值判据：0 / "" / false / null / 缺键为假，<b>非空字符串 "0" 与空数组都是真</b>。 */
  private static boolean isTruthy(JsonNode value) {
    if (value == null || value.isMissingNode() || value.isNull()) {
      return false;
    }
    if (value.isBoolean()) {
      return value.booleanValue();
    }
    if (value.isNumber()) {
      double d = value.doubleValue();
      return d != 0d && !Double.isNaN(d);
    }
    if (value.isTextual()) {
      return !value.asText().isEmpty();
    }
    return true;
  }
}
