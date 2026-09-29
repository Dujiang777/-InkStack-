package com.inkstack.user;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.Avatars;
import com.inkstack.common.Nicknames;
import com.inkstack.common.NodeShapes;
import com.inkstack.entity.MeRows;
import com.inkstack.mapper.UserMapper;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code PATCH /api/me/profile} —— 昵称 / 印文 / 印泥色 / 印式 / 简介。
 *
 * <p>回给前端的是<b>清洗后的值</b>而不是回读数据库：印章工坊的预览要靠这次响应立刻重绘，
 * 省一次 round-trip。因此"印文留空时按昵称首字兜底"这条规则必须与写库那条完全一致，
 * 否则预览与刷新后长得不一样。
 */
@RestController
public class ProfileController {

  private final UserMapper users;

  public ProfileController(UserMapper users) {
    this.users = users;
  }

  @PatchMapping("/api/me/profile")
  public ResponseEntity<Map<String, Object>> patch(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    JsonNode body = Bodies.json(request);
    String nickname = Nicknames.clean(Bodies.text(body, "nickname"));
    String avatarText = NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(body, "avatarText")), 2);
    String avatarTone = Avatars.cleanTone(Bodies.text(body, "avatarTone"));
    String avatarShape = Avatars.cleanShape(Bodies.text(body, "avatarShape"));
    String bio = NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(body, "bio")), 120);
    if (nickname.isEmpty()) {
      return ResponseEntity.badRequest().body(Map.of("error", "昵称不能为空"));
    }
    // 印文没填就用昵称首字；Node 同为 UTF-16 码元切片，代理对（emoji 昵称）两侧一样切半个
    String seal = avatarText.isEmpty() ? NodeShapes.slice(nickname, 1) : avatarText;
    try {
      users.updateProfile(me.id(), nickname, seal, avatarTone, avatarShape,
          bio.isEmpty() ? null : bio);
    } catch (RuntimeException failed) {
      return ResponseEntity.status(500).body(Map.of("error", "保存失败（数据库异常）"));
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("nickname", nickname);
    out.put("avatarText", seal);
    out.put("avatarTone", avatarTone);
    out.put("avatarShape", avatarShape);
    out.put("bio", bio);
    return ResponseEntity.ok(out);
  }

  /**
   * {@code GET /api/me/profile} —— 个人中心显示的那五个字段（P7f-1f-a）。
   *
   * <p>它原本是一句写在 {@code app/me/page.tsx} 里的 {@code pool.query}：没有 HTTP 面，
   * 所以对拍、契约基线、路由盘点三道全绿也看不见它。默认值（印文留空回退昵称首字、
   * 注册日缺省 "—"）照页面原来的写法搬过来，"预览与刷新后长得不一样"这条老约束
   * 对读侧同样成立。
   *
   * <p>数据库异常时这里<b>直接抛</b>，不再复刻页面那句 {@code catch} 后"简介显示为空"的降级：
   * 一条读接口的静默降级会让读者以为账号真的没填简介，而 {@code lib/java-source.ts} 的
   * 第三条硬规矩就是"失败必须抛出"。
   */
  @GetMapping("/api/me/profile")
  public ResponseEntity<Map<String, Object>> read(@Current SessionUser me) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    MeRows.Profile r = users.profileRow(me.id());
    // JS 的 slice(0,1) 取的是 UTF-16 码元，emoji 昵称会切出半个——这是页面一直在依赖的形状，保持
    String sealFallback = NodeShapes.slice(me.nickname(), 1);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("bio", r == null ? "" : NodeShapes.text(r.getBio()));
    String seal = r == null ? "" : NodeShapes.text(r.getAvatarText());
    out.put("avatarText", seal.isEmpty() ? sealFallback : seal);
    out.put("avatarTone", r == null ? "" : NodeShapes.text(r.getAvatarTone()));
    out.put("avatarShape", r == null ? "" : NodeShapes.text(r.getAvatarShape()));
    out.put("createdAt", r == null || r.getCreatedAt() == null ? "—" : r.getCreatedAt());
    return ResponseEntity.ok(out);
  }
}
