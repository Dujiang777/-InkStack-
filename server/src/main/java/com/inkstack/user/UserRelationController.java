package com.inkstack.user;

import com.inkstack.entity.FollowCounts;
import com.inkstack.mapper.SocialMapper;
import com.inkstack.session.SessionService;
import com.inkstack.session.SessionUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 作者与浏览者之间的关系一次取全：粉丝数、关注数、我是否已关注。
 *
 * <p>合成一个接口而不是三个，是因为文章页与作者页都要同时用这三样——
 * 换成 Java 数据源后每个调用都是一次 HTTP 往返，拆开纯属浪费。
 * Node 侧的 isFollowing() 与 followStats() 共享这一次请求（见 lib/java-source.ts 的 cache 合流）。
 */
@RestController
@RequestMapping("/api/users/{id}")
public class UserRelationController {

  private final SocialMapper social;
  private final SessionService sessionService;

  public UserRelationController(SocialMapper social, SessionService sessionService) {
    this.social = social;
    this.sessionService = sessionService;
  }

  @GetMapping("/relation")
  public Map<String, Object> relation(@PathVariable long id, HttpServletRequest request) {
    FollowCounts counts = social.followCounts(id);
    SessionUser viewer = sessionService.resolve(request).orElse(null);
    boolean viewerFollows = viewer != null && viewer.id() != id
        && social.existsFollow(viewer.id(), id) != null;
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("followers", counts == null || counts.getFollowers() == null ? 0L : counts.getFollowers());
    body.put("following", counts == null || counts.getFollowing() == null ? 0L : counts.getFollowing());
    body.put("viewerFollows", viewerFollows);
    return body;
  }
}
