package com.inkstack.money;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.MoneyRows;
import com.inkstack.mapper.MoneyMapper;
import com.inkstack.money.MoneyService.BoostResult;
import com.inkstack.money.MoneyService.BundleResult;
import com.inkstack.money.MoneyService.TipResult;
import com.inkstack.money.MoneyService.UnlockResult;
import com.inkstack.notify.Notifier;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 墨水经济的四条写接口。身份一律只认签名 Cookie 里的 uid，金额不接受前端传值
 * （加热价、解锁价、打包价都从库里取，打赏只认 10 / 50 两档）。
 *
 * <p>站内信在<b>动钱的事务之外</b>发：通知失败不能把一次已经落账的操作报成失败，
 * 所以 Notifier 内部吞异常，这里也不看它的返回。
 */
@RestController
public class MoneyController {

  private final MoneyService money;
  private final MoneyMapper queries;
  private final Notifier notifier;

  public MoneyController(MoneyService money, MoneyMapper queries, Notifier notifier) {
    this.money = money;
    this.queries = queries;
    this.notifier = notifier;
  }

  @PostMapping("/api/articles/{slug}/unlock")
  public ResponseEntity<Map<String, Object>> unlock(
      @Current SessionUser me, @PathVariable String slug) {
    if (me == null) {
      return err(401, "登录后才能解锁");
    }
    UnlockResult r = money.unlock(slug, me.id());
    if (!r.ok()) {
      return err(unlockStatus(r.error()), r.error());
    }
    if (r.price() == 0) {
      Map<String, Object> already = new LinkedHashMap<>();
      already.put("ok", true);
      already.put("already", true);
      already.put("message", "已解锁过本文");
      return ResponseEntity.ok(already);
    }
    notifyAuthorUnlocked(slug, me.nickname(), r.price(), r.authorGot());
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("price", r.price());
    body.put("authorGot", r.authorGot());
    body.put("balance", r.balance());
    return ResponseEntity.ok(body);
  }

  @PostMapping("/api/articles/{slug}/tip")
  public ResponseEntity<Map<String, Object>> tip(
      @Current SessionUser me, @PathVariable String slug, HttpServletRequest request) {
    if (me == null) {
      return err(401, "登录后才能打赏");
    }
    double raw = Bodies.number(Bodies.json(request), "amount");
    if (!MoneyService.isTipTier(raw)) {
      return err(400, MoneyService.tipTierError());
    }
    TipResult r = money.tip(slug, me.id(), (long) raw);
    if (!r.ok()) {
      return err(status(r.code(), 400), r.error());
    }
    notifier.send(r.toUserId(), "tip", "收到墨水打赏",
        me.nickname() + " 打赏了 " + r.amount() + " 点墨，你收到 " + r.authorGot() + " 点",
        "/article/" + slug);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("tipped", r.amount());
    body.put("authorGot", r.authorGot());
    body.put("balance", r.balance());
    return ResponseEntity.ok(body);
  }

  /** 加热的 forbidden 是 403（不是打赏那样的 400）：这是"权限"而不是"参数"问题。 */
  @PostMapping("/api/articles/{slug}/boost")
  public ResponseEntity<Map<String, Object>> boost(
      @Current SessionUser me, @PathVariable String slug) {
    if (me == null) {
      return err(401, "登录后才能加热文章");
    }
    BoostResult r = money.boost(slug, me.id());
    if (!r.ok()) {
      return err(status(r.code(), 403), r.error());
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("cost", r.cost());
    body.put("balance", r.balance());
    body.put("boostUntil", r.boostUntil());
    return ResponseEntity.ok(body);
  }

  /** 打包价与分摊都由服务端决定，路径里的 id 只做"存不存在/是不是正整数"的校验。 */
  @PostMapping("/api/series/{id}/bundle")
  public ResponseEntity<Map<String, Object>> bundle(
      @Current SessionUser me, @PathVariable String id) {
    if (me == null) {
      return err(401, "请先登录");
    }
    long seriesId = Bodies.positiveId(id);
    if (seriesId <= 0) {
      return err(404, "专栏不存在");
    }
    BundleResult r = money.bundle(seriesId, me.id());
    if (!r.ok()) {
      return err(status(r.code(), 400), r.error());
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("price", r.price());
    body.put("authorGot", r.authorGot());
    body.put("unlocked", r.unlocked());
    body.put("balance", r.balance());
    body.put("already", r.already());
    return ResponseEntity.ok(body);
  }

  /** 解锁成功后的作者通知：Node 在路由里重查一次标题，这里同样重查（事务已经提交）。 */
  private void notifyAuthorUnlocked(String slug, String nickname, long price, long authorGot) {
    MoneyRows.ArticleRef art;
    try {
      art = queries.articleRef(slug);
    } catch (RuntimeException unreadable) {
      return;
    }
    if (art == null) {
      return;
    }
    notifier.send(NodeShapes.num(art.getAuthorId()), "unlock", "文章被解锁",
        nickname + " 花费 " + price + " 点墨解锁《" + art.getTitle() + "》，你到账 " + authorGot + " 点",
        "/article/" + slug);
  }

  private static int status(MoneyService.Fail code, int forbiddenStatus) {
    return switch (code) {
      case NOTFOUND -> 404;
      case FORBIDDEN -> forbiddenStatus;
      case INSUFFICIENT -> 402;
      case SERVER -> 500;
    };
  }

  /**
   * 解锁没有 fail code，状态码由 error 文案的子串决定——这是 Node 原样。
   * 两边共用同一批文案，所以子串判定也共用；改文案必须连带回头看这里，否则状态码会静默变化。
   */
  private static int unlockStatus(String error) {
    if (error.contains("不存在")) {
      return 404;
    }
    if (error.contains("无需") || error.contains("免费")) {
      return 400;
    }
    if (error.contains("墨水") || error.contains("余额")) {
      return 402;
    }
    return 500;
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }
}
