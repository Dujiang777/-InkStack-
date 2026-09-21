package com.inkstack.auth;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * 登录爆破滑窗限流，语义对齐 lib/rate-limit.ts：窗口 15 分钟、5 次失败即锁，
 * hit 先记再判（所以第 5 次失败当场就锁），verdict 只查不记。
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
    return evaluate(key, false);
  }

  public Verdict hit(String key) {
    return evaluate(key, true);
  }

  public void clear(String key) {
    buckets.remove(key);
  }

  private Verdict evaluate(String key, boolean record) {
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
    boolean locked = hits.size() >= MAX_FAILS;
    long retryAfterSec = locked ? (long) Math.ceil((WINDOW_MS - (now - hits.get(0))) / 1000.0) : 0;
    return new Verdict(locked, retryAfterSec, hits.size());
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

  public record Verdict(boolean locked, long retryAfterSec, int fails) {

    public int remaining() {
      return MAX_FAILS - fails;
    }
  }
}
