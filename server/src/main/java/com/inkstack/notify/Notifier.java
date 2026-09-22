package com.inkstack.notify;

import com.inkstack.mapper.NotificationMapper;
import org.springframework.stereotype.Service;

/**
 * 站内通知。<b>永不阻塞主流程</b>：钱已经落账之后才发，发不出去也只是没有小红点，
 * 绝不能因为通知失败把一次成功的打赏/解锁报成失败。所以这里吞掉一切异常。
 */
@Service
public class Notifier {

  private final NotificationMapper notifications;

  public Notifier(NotificationMapper notifications) {
    this.notifications = notifications;
  }

  /** 列宽截断与 Node 的 slice 一致（JS 与 Java 同样按 UTF-16 码元计长）。 */
  public void send(long userId, String type, String title, String body, String link) {
    if (userId == 0L) {
      return;
    }
    try {
      notifications.insert(userId, type, cut(title, 200), cut(body, 500), cut(link, 255));
    } catch (RuntimeException ignored) {
      // 通知失败静默
    }
  }

  private static String cut(String value, int max) {
    if (value == null) {
      return null;
    }
    return value.length() <= max ? value : value.substring(0, max);
  }
}
