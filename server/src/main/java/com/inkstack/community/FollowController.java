package com.inkstack.community;

import com.inkstack.common.NodeShapes;
import com.inkstack.community.CommunityService.Followed;
import com.inkstack.entity.FollowCounts;
import com.inkstack.notify.Notifier;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 关注 / 取关（toggle）。
 *
 * <p>响应键序是 {@code ok, followers, following}：Node 先展开 stats 再写 following，
 * 那个布尔会把同名计数覆盖掉——顺序反了就变成"关注成功却报计数"。
 */
@RestController
public class FollowController {

  private final CommunityService community;
  private final Notifier notifier;

  public FollowController(CommunityService community, Notifier notifier) {
    this.community = community;
    this.notifier = notifier;
  }

  @PostMapping("/api/users/{id}/follow")
  public ResponseEntity<Map<String, Object>> follow(
      @Current SessionUser me, @PathVariable String id) {
    if (me == null) {
      return err(401, "请先登录");
    }
    long targetId = Bodies.positiveId(id);
    if (targetId <= 0) {
      return err(404, "用户不存在");
    }
    Followed r = community.toggleFollow(me.id(), targetId);
    if (r == null) {
      return err(400, "不能关注自己");
    }
    // 取关不发通知，避免打扰；被关注者昵称查不到时只是没有这封信。
    if (r.following() && r.targetNickname() != null) {
      notifier.send(targetId, "system", "有新读者关注了你",
          me.nickname() + " 成为了你的读者", "/me");
    }
    FollowCounts stats = r.stats();
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("followers", NodeShapes.num(stats == null ? null : stats.getFollowers()));
    out.put("following", r.following());
    return ResponseEntity.ok(out);
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }
}
