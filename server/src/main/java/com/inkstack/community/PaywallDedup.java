package com.inkstack.community;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * 付费墙到达埋点的防刷窗口：同一 IP 对同一篇文章 30 分钟内只计一次。
 *
 * <p>漏斗要的是"到达人次"，重复挂载或脚本刷量都不该放大它。窗口放在进程内存里而不是库里，
 * 是为了让这条埋点在任何写压力下的成本都是一次哈希查表——它与 Node 的
 * {@code globalThis.__inkPaywallSeen} 同形态，各实例各记各的，宁可少计不可重复计。
 */
@Component
public class PaywallDedup {

  private static final long WINDOW_MS = 30 * 60 * 1000L;
  private static final int PRUNE_AT = 20_000;

  private final Map<String, Long> seen = new ConcurrentHashMap<>();

  /** true = 本次可计数；false = 窗口内已计过。 */
  public boolean firstHit(String ip, String slug) {
    long now = System.currentTimeMillis();
    String key = ip + ":" + slug;
    Long last = seen.get(key);
    if (last != null && now - last < WINDOW_MS) {
      return false;
    }
    seen.put(key, now);
    if (seen.size() > PRUNE_AT) {
      seen.entrySet().removeIf(entry -> now - entry.getValue() >= WINDOW_MS);
    }
    return true;
  }

  /** 供测试与排查：当前窗口内已记过多少条。 */
  public int size() {
    return seen.size();
  }
}
