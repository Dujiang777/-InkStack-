package com.inkstack.auth;

import com.inkstack.mapper.RateHitMapper;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Component;

/**
 * 滑窗限流，语义对齐 lib/rate-limit.ts：hit 先记再判（所以第 max 次当场就锁），
 * verdict 只查不记，clear 成功后清零。
 *
 * <p>默认窗口 15 分钟 / 5 次（登录爆破）；send-code 用 10 次，所以 max 走参数而不是再写一个类。
 *
 * <p>P7e 起计数落在 MySQL 的 {@code rate_hits} 表里，不再是本进程的 Map：双轨期同一个 key
 * 由两栈共同记账，切流量也不再清零。窗口的时钟是 MySQL 的 NOW(3)，两栈读到的解锁时间是同一个。
 *
 * <p>库不可用时放行（只 WARN 一次）：限流器自己挂了不该把登录变成 500，也不该把"读不到计数"
 * 当成"读到了很多次"。
 */
@Component
public class LoginGuard {

  private static final Logger log = LoggerFactory.getLogger(LoginGuard.class);

  private static final int MAX_FAILS = 5;
  private static final long WINDOW_MS = 15 * 60 * 1000L;
  private static final int WINDOW_SEC = 15 * 60;
  private static final long SWEEP_EVERY_MS = 10 * 60 * 1000L;

  private final RateHitMapper hits;
  private final AtomicLong lastSweep = new AtomicLong(0);
  private final AtomicBoolean warned = new AtomicBoolean(false);

  public LoginGuard(RateHitMapper hits) {
    this.hits = hits;
  }

  public Verdict verdict(String key) {
    return verdict(key, MAX_FAILS);
  }

  public Verdict verdict(String key, int max) {
    try {
      return read(key, max);
    } catch (DataAccessException e) {
      return failOpen(max, e);
    }
  }

  public Verdict hit(String key) {
    return hit(key, MAX_FAILS);
  }

  public Verdict hit(String key, int max) {
    try {
      // 先扫掉本桶的过期行，窗口内计数就不会被历史值撑大
      hits.prune(key, WINDOW_SEC);
      hits.insert(key);
      sweepIfNeeded();
      return read(key, max);
    } catch (DataAccessException e) {
      return failOpen(max, e);
    }
  }

  public void clear(String key) {
    try {
      hits.clear(key);
    } catch (DataAccessException e) {
      failOpen(MAX_FAILS, e);
    }
  }

  private Verdict read(String key, int max) {
    RateHitMapper.Window w = hits.window(key, WINDOW_SEC);
    long fails = w.getN();
    boolean locked = fails >= max;
    long retryAfterSec = locked ? (long) Math.ceil((WINDOW_MS - w.getAgeMs()) / 1000.0) : 0;
    return new Verdict(locked, retryAfterSec, (int) fails, max);
  }

  private void sweepIfNeeded() {
    long now = System.currentTimeMillis();
    long prev = lastSweep.get();
    if (now - prev < SWEEP_EVERY_MS || !lastSweep.compareAndSet(prev, now)) {
      return;
    }
    hits.sweepAll();
  }

  private Verdict failOpen(int max, DataAccessException e) {
    if (warned.compareAndSet(false, true)) {
      log.warn("[rate-limit] 计数库不可用，限流暂时放行（本进程只 WARN 这一次）：{}", e.toString());
    }
    return new Verdict(false, 0, 0, max);
  }

  public record Verdict(boolean locked, long retryAfterSec, int fails, int max) {

    public int remaining() {
      return max - fails;
    }
  }
}
