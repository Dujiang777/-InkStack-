package com.inkstack.ai;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/agent/status}：告诉前端"当前回答由什么驱动"，三档判据全来自配置。
 *
 * <p>探活只给 1.2 秒且<b>失败就如实降档</b>——这一项是给读者看的徽标，
 * 谎报"接入真人大模型"比显示"演示模式"糟得多。所以两侧必须读同一组环境变量：
 * {@code AGENT_SERVICE_URL} 决定第一档、{@code DEEPSEEK_API_KEY} 决定第二档，
 * 两个都没配就一定是 demo（也就是"绝不真调上游"）。
 */
@RestController
public class AgentStatusController {

  private final String agentServiceUrl;
  private final String deepseekKey;
  private final HttpClient http = HttpClient.newBuilder()
      .connectTimeout(Duration.ofMillis(1200))
      .build();

  public AgentStatusController(@Value("${inkstack.agent.service-url:}") String agentServiceUrl,
      @Value("${inkstack.agent.deepseek-key:}") String deepseekKey) {
    this.agentServiceUrl = agentServiceUrl;
    this.deepseekKey = deepseekKey;
  }

  @GetMapping("/api/agent/status")
  public ResponseEntity<Map<String, Object>> status() {
    if (agentServiceUrl != null && !agentServiceUrl.isBlank() && healthy(agentServiceUrl)) {
      return ResponseEntity.ok(Map.of("ok", true, "mode", "agentscope"));
    }
    if (deepseekKey != null && !deepseekKey.isBlank()) {
      return ResponseEntity.ok(Map.of("ok", true, "mode", "live"));
    }
    return ResponseEntity.ok(Map.of("ok", true, "mode", "demo"));
  }

  private boolean healthy(String base) {
    String trimmed = base.trim();
    String url = (trimmed.endsWith("/") ? trimmed.substring(0, trimmed.length() - 1) : trimmed) + "/health";
    try {
      HttpResponse<byte[]> res = http.send(
          HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMillis(1200)).GET().build(),
          HttpResponse.BodyHandlers.ofByteArray());
      return res.statusCode() >= 200 && res.statusCode() < 300;
    } catch (InterruptedException slow) {
      Thread.currentThread().interrupt();
      return false;
    } catch (Exception down) {
      return false;
    }
  }
}
