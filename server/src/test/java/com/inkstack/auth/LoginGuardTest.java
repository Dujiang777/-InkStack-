package com.inkstack.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.inkstack.mapper.RateHitMapper;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;

/**
 * 限流判定。计数已经搬到 MySQL，这里单测的是"搬过去之后仍然成立的那部分语义"：
 * 先记再判、Retry-After 由最早一次命中的年龄推出来、库挂了必须放行而不是锁死。
 *
 * <p>跨栈对得上账这件事不在这里验（那是第十七道闸门的活），这里只验 Java 自己的判断逻辑。
 */
class LoginGuardTest {

  /** 脚本化的假 mapper：window() 返回预设行数，同时记下调用顺序。 */
  private static final class Fake implements RateHitMapper {

    final List<String> calls = new ArrayList<>();
    long n = 0;
    long ageMs = 0;
    boolean boom = false;

    private void call(String name) {
      if (boom) {
        throw new DataAccessResourceFailureException("假库：连接不上");
      }
      calls.add(name);
    }

    @Override
    public int insert(String bucket) {
      call("insert");
      return 1;
    }

    @Override
    public Window window(String bucket, int seconds) {
      call("window");
      Window w = new Window();
      w.setN(n);
      w.setAgeMs(ageMs);
      return w;
    }

    @Override
    public int prune(String bucket, int seconds) {
      call("prune");
      return 0;
    }

    @Override
    public int clear(String bucket) {
      call("clear");
      return 1;
    }

    @Override
    public int sweepAll() {
      call("sweepAll");
      return 0;
    }
  }

  @Test
  void 第max次失败当场就锁而不是下一次才锁() {
    Fake fake = new Fake();
    fake.n = 5;
    LoginGuard guard = new LoginGuard(fake);
    LoginGuard.Verdict v = guard.hit("login:a@b.c:1.2.3.4");
    assertTrue(v.locked(), "hit 是先记再判：第 5 次失败当场就该锁");
    assertEquals(5, v.fails());
    assertEquals(0, v.remaining());
  }

  @Test
  void RetryAfter从最早一次命中的年龄推() {
    Fake fake = new Fake();
    fake.n = 5;
    fake.ageMs = 899_001; // 15 分钟窗口已经走完 899.001 秒
    LoginGuard guard = new LoginGuard(fake);
    assertEquals(1, guard.hit("k").retryAfterSec(), "剩余不足 1 秒也要报 1 秒，不能报 0 让调用方以为已解锁");
    fake.ageMs = 0;
    assertEquals(900, guard.hit("k").retryAfterSec());
    fake.n = 4;
    assertEquals(0, guard.hit("k").retryAfterSec(), "没锁就不该有 Retry-After");
  }

  @Test
  void 记一次之前先扫掉本桶的过期行() {
    Fake fake = new Fake();
    new LoginGuard(fake).hit("k");
    assertEquals(List.of("prune", "insert", "sweepAll", "window"), fake.calls,
        "顺序错了的话，窗口里的旧行会被算进本次判定");
  }

  @Test
  void 库不可用时放行而不是锁死() {
    Fake fake = new Fake();
    fake.boom = true;
    LoginGuard guard = new LoginGuard(fake);
    LoginGuard.Verdict v = guard.hit("login:a@b.c:1.2.3.4", 10);
    assertFalse(v.locked(), "读不到计数不能当成读到了很多次");
    assertFalse(guard.verdict("k").locked());
    assertEquals(10, v.max(), "放行时也要把上限带回给调用方拼提示语");
    guard.clear("k"); // 清理失败同样不能把异常抛到控制器外面
  }

  @Test
  void 成功后清零走的是同一条SQL() {
    Fake fake = new Fake();
    LoginGuard guard = new LoginGuard(fake);
    guard.clear("pwdchg:7:1.2.3.4");
    assertEquals(List.of("clear"), fake.calls);
  }
}
