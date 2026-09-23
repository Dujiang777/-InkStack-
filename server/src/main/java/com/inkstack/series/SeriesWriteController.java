package com.inkstack.series;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.NodeShapes;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 专栏的增改删。读侧在 {@link SeriesReadController}，两条不合并是因为读写门禁不同：
 * 读要能匿名访问，写三条全部要求"本人"。
 *
 * <p>注意 {@code GET /api/series} 这一支：Node 的它是"我的专栏"（要登录），
 * Java 的它是公开合集架。方法集合相同、语义不同，切流清单看不出这个差别，
 * 所以 {@code /api/series} 前缀在 P7 收口前不能整体切——见闸门 8 的冲突登记表。
 */
@RestController
public class SeriesWriteController {

  private static final int TITLE_MIN = 2;
  private static final int TITLE_MAX = 60;
  private static final int ITEM_LIMIT = 100;

  private final SeriesWriteService series;

  public SeriesWriteController(SeriesWriteService series) {
    this.series = series;
  }

  @PostMapping("/api/series")
  public ResponseEntity<Map<String, Object>> create(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "登录后才能开专栏"));
    }
    JsonNode body = Bodies.strictJson(request);
    if (body == null) {
      return ResponseEntity.badRequest().body(Map.of("error", "请求格式有误"));
    }
    String title = NodeShapes.jsTrim(Bodies.text(body, "title"));
    if (title.length() < TITLE_MIN || title.length() > TITLE_MAX) {
      return ResponseEntity.badRequest().body(Map.of("error", "专栏题名需 2-60 字"));
    }
    String description = NodeShapes.jsTrim(Bodies.text(body, "description"));
    Long id = series.create(me.id(),
        NodeShapes.slice(title, 120), NodeShapes.slice(description, 500));
    if (id == null) {
      return ResponseEntity.status(500).body(Map.of("error", "创建失败，请稍后再试"));
    }
    return ResponseEntity.ok(Map.of("ok", true, "id", id));
  }

  @PatchMapping("/api/series/{id}")
  public ResponseEntity<Map<String, Object>> update(
      @Current SessionUser me, @PathVariable String id, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    long seriesId = Bodies.positiveId(id);
    if (seriesId == 0) {
      return ResponseEntity.status(404).body(Map.of("error", "专栏不存在"));
    }
    JsonNode body = Bodies.strictJson(request);
    if (body == null) {
      return ResponseEntity.badRequest().body(Map.of("error", "请求格式有误"));
    }
    try {
      ResponseEntity<Map<String, Object>> meta = patchMeta(me, seriesId, body);
      if (meta != null) {
        return meta;
      }
      List<String> slugs = Bodies.stringArray(body, "slugs", ITEM_LIMIT);
      if (slugs != null && !series.setItems(seriesId, me.id(), slugs)) {
        return ResponseEntity.badRequest().body(Map.of("error",
            "篇目设置失败：专栏不存在，或所选文章未发布/未过审/不归你所有"));
      }
      return ResponseEntity.ok(Map.of("ok", true));
    } catch (RuntimeException failed) {
      return ResponseEntity.status(500).body(Map.of("error", "更新失败，请稍后再试"));
    }
  }

  /** 元信息与篇目是两段独立的写：Node 就是"带哪个改哪个"，一个失败不影响另一段是否被尝试。 */
  private ResponseEntity<Map<String, Object>> patchMeta(
      SessionUser me, long seriesId, JsonNode body) {
    boolean setTitle = Bodies.has(body, "title");
    boolean setDescription = Bodies.has(body, "description");
    boolean setBundlePrice = Bodies.has(body, "bundlePrice");
    if (!setTitle && !setDescription && !setBundlePrice) {
      return null;
    }
    String title = null;
    if (setTitle) {
      title = NodeShapes.jsTrim(Bodies.text(body, "title"));
      if (title.length() < TITLE_MIN || title.length() > TITLE_MAX) {
        return ResponseEntity.badRequest().body(Map.of("error", "专栏题名需 2-60 字"));
      }
      title = NodeShapes.slice(title, 120);
    }
    String description = setDescription
        ? NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(body, "description")), 500)
        : null;
    Integer bundlePrice = null;
    if (setBundlePrice) {
      // null / "" / 0 = 关闭打包；1-99999 = 一口价。Number(null) 与 Number("") 都是 0，
      // 所以三者殊途同归落 NULL，不需要为 null 单开分支。
      double raw = Bodies.number(body, "bundlePrice");
      long n = (long) Math.floor(Double.isNaN(raw) ? 0d : raw);
      if (n < 0 || n > 99_999) {
        return ResponseEntity.badRequest().body(Map.of("error", "打包价需在 1-99999 点墨之间"));
      }
      bundlePrice = n > 0 ? (int) n : null;
    }
    if (!series.updateMeta(seriesId, me.id(),
        setTitle, title, setDescription, description, setBundlePrice, bundlePrice)) {
      return ResponseEntity.status(403).body(Map.of("error", "专栏不存在或无权修改"));
    }
    return null;
  }

  @DeleteMapping("/api/series/{id}")
  public ResponseEntity<Map<String, Object>> delete(
      @Current SessionUser me, @PathVariable String id) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    long seriesId = Bodies.positiveId(id);
    if (seriesId == 0) {
      return ResponseEntity.status(404).body(Map.of("error", "专栏不存在"));
    }
    try {
      if (!series.delete(seriesId, me.id())) {
        return ResponseEntity.status(403).body(Map.of("error", "专栏不存在或无权删除"));
      }
      return ResponseEntity.ok(Map.of("ok", true));
    } catch (RuntimeException failed) {
      return ResponseEntity.status(500).body(Map.of("error", "删除失败，请稍后再试"));
    }
  }
}
