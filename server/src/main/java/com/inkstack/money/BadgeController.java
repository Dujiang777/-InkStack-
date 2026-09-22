package com.inkstack.money;

import com.inkstack.money.BadgeService.Claim;
import com.inkstack.money.BadgeService.Outcome;
import com.inkstack.notify.Notifier;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Current;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 集齐徽章的一次性领取。没有入参：判据全部来自服务端实时算出的成就进度，
 * 前端传什么都不认。
 */
@RestController
public class BadgeController {

  private final BadgeService badges;
  private final Notifier notifier;

  public BadgeController(BadgeService badges, Notifier notifier) {
    this.badges = badges;
    this.notifier = notifier;
  }

  @PostMapping("/api/me/badge-claim")
  public ResponseEntity<Map<String, Object>> claim(@Current SessionUser me) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    Claim claim = badges.claim(me.id());
    if (claim.outcome() == Outcome.MISSING) {
      return ResponseEntity.badRequest()
          .body(Map.of("error", "还差 " + claim.missing() + " 枚徽章才能领取奖励"));
    }
    if (claim.outcome() == Outcome.CLAIMED) {
      return ResponseEntity.status(409).body(Map.of("error", "奖励已经领取过啦"));
    }
    if (claim.outcome() == Outcome.FAILED) {
      return ResponseEntity.status(500).body(Map.of("error", "发放失败，请稍后再试"));
    }
    // 站内信在事务外发：钱已经落账，通知失败不能把这次领取报成失败
    notifier.send(me.id(), "system", "成就墙全部点亮！",
        "恭喜集齐 " + claim.total() + " 枚徽章，奖励 " + BadgeService.AMOUNT + " 滴墨水已入账。",
        "/me");
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("amount", BadgeService.AMOUNT);
    body.put("balance", claim.balance());
    body.put("message", "集齐 " + claim.total() + " 枚徽章，" + BadgeService.AMOUNT + " 滴墨水已入账！");
    return ResponseEntity.ok(body);
  }
}
