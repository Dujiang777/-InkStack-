package com.inkstack.money;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.money.TopupService.Order;
import com.inkstack.money.TopupService.Pay;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 收银台：<b>服务端是唯一可信的计价方</b>——点数与价格取自代码里的套餐常量表，
 * 前端只传套餐 key 与订单号，金额不接受入参。
 *
 * <p>GET /orders 无需登录（定价要公开显示），POST 两笔都要。
 * 请求体在每个端点里只读一次（Servlet 输入流不可重放），取完再逐字段取用。
 */
@RestController
@RequestMapping("/api/topup")
public class TopupController {

  private final TopupService topup;
  private final String nodeEnv;

  public TopupController(TopupService topup,
      @Value("${inkstack.node-env:development}") String nodeEnv) {
    this.topup = topup;
    this.nodeEnv = nodeEnv;
  }

  @GetMapping("/orders")
  public Map<String, Object> packs() {
    return Map.of("packs", TopupService.PACKS);
  }

  @PostMapping("/orders")
  public ResponseEntity<Map<String, Object>> create(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return err(401, "登录后才能充值");
    }
    String packKey = Bodies.text(Bodies.json(request), "packKey").trim();
    Order order = topup.createOrder(me.id(), packKey);
    if (!order.ok()) {
      return err(400, order.error());
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("orderNo", order.orderNo());
    body.put("pack", order.pack());
    return ResponseEntity.ok(body);
  }

  /**
   * 自助到账。<b>生产环境整条通道关死</b>：channel 由客户端自报，只要 pay() 不验签，
   * 传个 "wechat" 就等于零成本刷墨（Node v17.2 的严重级修复，这里同一道闸）。
   * 真支付回调上线时走独立路由，不开放这个接口。
   */
  @PostMapping("/pay")
  public ResponseEntity<Map<String, Object>> pay(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return err(401, "登录后才能支付");
    }
    JsonNode json = Bodies.json(request);
    String orderNo = Bodies.text(json, "orderNo").trim();
    if (orderNo.isEmpty()) {
      return err(400, "缺少订单号");
    }
    String reported = Bodies.text(json, "channel");
    String channel = TopupService.CHANNELS.contains(reported) ? reported : "demo";
    if ("production".equals(nodeEnv)) {
      return err(501, "该支付通道暂未开放");
    }
    Pay paid = topup.pay(me.id(), orderNo, channel);
    if (!paid.ok()) {
      return err(400, paid.error());
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    body.put("points", paid.points());
    body.put("balance", paid.balance());
    body.put("pack", paid.pack());
    return ResponseEntity.ok(body);
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }
}
