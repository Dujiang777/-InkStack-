package com.inkstack.money;

import com.inkstack.money.CheckinService.Post;
import com.inkstack.money.CheckinService.Status;
import com.inkstack.money.CheckinService.Tier;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Current;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 每日签到的读与写。
 *
 * <p>GET 与 POST 都回同一批字段，且 balance 的口径刻意不同：状态里给的是
 * <b>会话里的余额</b>（签到动作之前的），只有真正发了墨的那次才回读新余额。
 * 这不是疏忽——Node 就是这么写的，前端"已签到"分支要的正是旧值。
 */
@RestController
@RequestMapping("/api/checkin")
public class CheckinController {

  private final CheckinService checkin;

  public CheckinController(CheckinService checkin) {
    this.checkin = checkin;
  }

  @GetMapping
  public ResponseEntity<Map<String, Object>> status(@Current SessionUser me) {
    if (me == null) {
      return err(401, "未登录");
    }
    Status s = checkin.status(me.id());
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("checkedInToday", s.checkedInToday());
    body.put("streak", s.streak());
    body.put("cycleDay", s.cycleDay());
    body.put("reward", s.reward());
    body.put("next", tier(s.next()));
    body.put("balance", me.points());
    return ResponseEntity.ok(body);
  }

  @PostMapping
  public ResponseEntity<Map<String, Object>> checkin(@Current SessionUser me) {
    if (me == null) {
      return err(401, "登录后才能签到");
    }
    Post p = checkin.checkin(me.id());
    if (p.error() != null) {
      return err(500, p.error());
    }
    Map<String, Object> body = new LinkedHashMap<>();
    if (p.already()) {
      // 主键挡下的重复签到：200 + ok:false，状态按"今天已经签过"重算一遍
      Status s = checkin.status(me.id());
      body.put("ok", false);
      body.put("already", true);
      body.put("balance", me.points());
      body.put("checkedInToday", s.checkedInToday());
      body.put("streak", s.streak());
      body.put("cycleDay", s.cycleDay());
      body.put("reward", s.reward());
      body.put("next", tier(s.next()));
      return ResponseEntity.ok(body);
    }
    body.put("ok", true);
    body.put("reward", p.reward());
    body.put("balance", p.balance());
    body.put("streak", p.streak());
    body.put("cycleDay", p.cycleDay());
    body.put("checkedInToday", true);
    body.put("next", tier(p.next()));
    return ResponseEntity.ok(body);
  }

  /** next 为 null 表示下一签即收官；Map.of 不许 null 值，所以手写。 */
  private static Map<String, Object> tier(Tier next) {
    if (next == null) {
      return null;
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("days", next.days());
    out.put("reward", next.reward());
    return out;
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }
}
