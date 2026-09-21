package com.inkstack.auth;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * 滑窗限流，语义对齐 lib/rate-limit.ts：hit 先记再判（所以第 max 次当场就锁），
 * verdict 只查不记，clear 成功后清零。
 *
 * <p>默认窗口 15 分钟 / 5 次（登录爆破）；send-code 用 10 次，所以 max 走参数而不是再写一个类。
 *
 * <p>双轨期注意：这是<b>进程内</b>计数，Node 与 Java 各算各的，同一 IP 的实际容忍度
 * 会接近两栈之和。收口时机是全量切 Java 或换 Redis。
 */
@Component
public class LoginGuard {

  private static final int MAX_FAILS = 5;
  private static final long WINDOW_MS = 15 * 60 * 1000L;

  private final Map<String, List<Long>> buckets = new ConcurrentHashMap<>();

  public Verdict verdict(String key) {
    return evaluate(key, MAX_FAILS, false);
  }

  public Verdict verdict(String key, int max) {
    return evaluate(key, max, false);
  }

  public Verdict hit(String key) {
    return evaluate(key, MAX_FAILS, true);
  }

  public Verdict hit(String key, int max) {
    return evaluate(key, max, true);
  }

  public void clear(String key) {
    buckets.remove(key);
  }

  private Verdict evaluate(String key, int max, boolean record) {
    long now = System.currentTimeMillis();
    List<Long> hits = new ArrayList<>();
    List<Long> existing = buckets.get(key);
    if (existing != null) {
      for (Long t : existing) {
        if (now - t < WINDOW_MS) {
          hits.add(t);
        }
      }
    }
    if (record) {
      hits.add(now);
    }
    if (hits.isEmpty()) {
      buckets.remove(key);
    } else {
      buckets.put(key, hits);
    }
    if (buckets.size() > 5000) {
      sweepStale(now);
    }
    boolean locked = hits.size() >= max;
    long retryAfterSec = locked ? (long) Math.ceil((WINDOW_MS - (now - hits.get(0))) / 1000.0) : 0;
    return new Verdict(locked, retryAfterSec, hits.size(), max);
  }

  private void sweepStale(long now) {
    Iterator<Map.Entry<String, List<Long>>> it = buckets.entrySet().iterator();
    while (it.hasNext()) {
      List<Long> hits = it.next().getValue();
      hits.removeIf(t -> now - t >= WINDOW_MS);
      if (hits.isEmpty()) {
        it.remove();
      }
    }
  }

  public record Verdict(boolean locked, long retryAfterSec, int fails, int max) {

    public int remaining() {
      return max - fails;
    }
  }
}
