package com.inkstack.ai;

import java.io.InputStream;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 一条**真的能打断阻塞读**的上游截止。
 *
 * <p>为什么要有这个类：{@code HttpRequest.timeout(60s)} 只管到**响应头**。一次"200 都发了、
 * 头也到了、然后一个字节都不再吐"的上游挂起，会永远堵在 {@code InputStream.read()} 上——
 * 本机 Corretto 17 实测：请求超时设 4 秒，第 49 秒那次读仍然没有醒。而这一次读发生在 servlet
 * 的工作线程上，所以代价不是"这一屏在转圈"，是<b>一个 Tomcat worker 被永久占住</b>；
 * 攒够默认那 200 个，连 {@code GET /api/auth/me} 都不答了。旧写法"在两块数据之间判 deadline"
 * 对这种挂起完全无效（它得先等到下一块数据才有机会判）。
 *
 * <p>做法不需要换成非阻塞 IO：到点从另一条线程 {@code close()} 那条上游流，阻塞中的
 * {@code read()} 当场抛 {@code IOException: closed}（实测：close 返回的同一瞬间读侧就醒了）。
 * 调用方接住那一次 IOException，换成协议里本来就有的<b>一帧 {@code error}</b>——
 * 而不是静默收尾：这套 NDJSON 没有 {@code [DONE]} 哨兵、靠连接关闭收尾，
 * 于是"被截断"与"说完了"在读侧是不可区分的两件事，不给那一帧就等于把半截回答当完整回答。
 *
 * <p>语义是**整次交换的绝对截止**，不是"两次数据之间的空闲上限"——对齐 Node 的
 * {@code AbortSignal.timeout(60_000)}，那个信号同样是绝对的。要改成 idle 语义得先改判据。
 */
final class UpstreamDeadline implements AutoCloseable {

  /**
   * 全服务共用一个小的守护线程池就够：到点动作只有一次 {@code close()}，不碰业务数据。
   * 给 2 条线程是留余量——万一某次 close 卡在 TCP 上，别把后面的截止全拖住。
   */
  private static final ScheduledExecutorService WATCHDOG =
      Executors.newScheduledThreadPool(2, runnable -> {
        Thread t = new Thread(runnable, "upstream-deadline");
        t.setDaemon(true);
        return t;
      });

  private final ScheduledFuture<?> task;
  private final long timeoutMs;

  /** 先标记住再关流，读侧 catch 到的时候一定看得见。（用 Atomic 是因为挂截止的是静态方法。） */
  private final AtomicBoolean fired;

  private UpstreamDeadline(ScheduledFuture<?> task, long timeoutMs, AtomicBoolean marker) {
    this.task = task;
    this.timeoutMs = timeoutMs;
    this.fired = marker;
  }

  /**
   * 给这条上游流挂一个截止。{@code timeoutMs <= 0} = 不设限（这是留给运维的取舍口子：
   * 关掉它退化的就是本文件开头那个"永久占住一个 worker"的行为，所以调用方把 0 拦在外面了）。
   */
  static UpstreamDeadline arm(InputStream upstream, long timeoutMs) {
    if (timeoutMs <= 0) {
      return new UpstreamDeadline(null, timeoutMs, new AtomicBoolean());
    }
    AtomicBoolean fired = new AtomicBoolean();
    ScheduledFuture<?> task = WATCHDOG.schedule(() -> {
      fired.set(true);
      try {
        upstream.close();
      } catch (Exception alreadyGone) {
        // 流早就断了 = 要的效果已经达成，没什么可交代的
      }
    }, timeoutMs, TimeUnit.MILLISECONDS);
    return new UpstreamDeadline(task, timeoutMs, fired);
  }

  /** 是不是被截止关掉的。读侧据此把"卡住"与"上游半路断了"分开说。 */
  boolean stalled() {
    return fired.get();
  }

  /** 文案里那句"N 秒没有回音"由这里出，免得两处各写一个数字还写岔。 */
  String seconds() {
    return String.valueOf(Math.max(1, Math.round(timeoutMs / 1000.0)));
  }

  /** 上游正常说完话（或读侧自己先出错）时取消那颗还没到的定时任务。 */
  @Override
  public void close() {
    if (task != null) {
      task.cancel(false);
    }
  }
}
