package com.inkstack.auth;

import com.inkstack.common.Hex;
import com.inkstack.mapper.EmailCodeMapper;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 邮箱验证码：10 分钟有效、5 次尝试上限、60 秒重发冷却、10 分钟窗口最多 5 次。
 * 语义与 lib/verify-code.ts 逐条对齐（两栈共用同一张 email_codes 表，任何一条松紧不同都会互相绕开）。
 *
 * <p>三处并发正确性是原实现踩过的坑，搬过来时一个都不能丢：
 * <ol>
 *   <li><b>冷却/窗口判定与 INSERT 同事务 + FOR UPDATE</b>。原实现是"先 SELECT 判冷却再 INSERT"
 *       两条自动提交语句，实测 40 个并发签发<b>全部</b>通过判定，一次爆发给同一邮箱落 40 条码
 *       ——配合可伪造的 XFF 就等于能对任意邮箱无限发信（轰炸收件箱 + 烧光 SMTP 配额与域名信誉）。</li>
 *   <li><b>错误计数原子自增</b>。读-改-写会让并发错误码互相吞掉：实测 60 个并发错误请求
 *       attempts 只涨到 2，5 次上限形同虚设。</li>
 *   <li><b>消费=条件删除并核验影响行数</b>。"先比对再删"在同一枚码的两个并发请求里会双双通过，
 *       一次性验证码可被消费两次。</li>
 * </ol>
 */
@Service
public class EmailCodeService {

  private static final long CODE_TTL_MS = 10 * 60 * 1000L;
  private static final int MAX_ATTEMPTS = 5;
  private static final long RESEND_COOLDOWN_MS = 60 * 1000L;
  private static final long WINDOW_LIMIT_MS = 10 * 60 * 1000L;
  private static final int WINDOW_MAX = 5;

  private final EmailCodeMapper codes;
  private final SecureRandom random = new SecureRandom();

  public EmailCodeService(EmailCodeMapper codes) {
    this.codes = codes;
  }

  public record Issue(boolean ok, String code, String error) {}

  public record Check(boolean ok, String error) {}

  private static String codeHash(String email, String code) {
    return Hex.sha256Hex(email.toLowerCase() + "::" + code);
  }

  /** 签发。冷却/窗口判定与写入在同一事务里，靠 SELECT ... FOR UPDATE 串行化同一 (email, purpose)。 */
  @Transactional
  public Issue issue(String rawEmail, String purpose) {
    String mail = rawEmail.toLowerCase();
    try {
      List<LocalDateTime> recent = codes.lockRecent(mail, purpose);
      long now = System.currentTimeMillis();
      if (!recent.isEmpty()) {
        long last = toEpochMs(recent.get(0));
        if (now - last < RESEND_COOLDOWN_MS) {
          long wait = (long) Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000.0);
          return new Issue(false, null, "发送太频繁，请 " + wait + " 秒后再试");
        }
        if (recent.size() >= WINDOW_MAX
            && now - toEpochMs(recent.get(WINDOW_MAX - 1)) < WINDOW_LIMIT_MS) {
          return new Issue(false, null, "验证码请求过多，请 10 分钟后再试");
        }
      }
      String code = String.format("%06d", random.nextInt(1_000_000));
      codes.insert(mail, codeHash(mail, code), purpose, CODE_TTL_MS * 1000);
      return new Issue(true, code, null);
    } catch (RuntimeException e) {
      return new Issue(false, null, "验证码签发失败，请稍后再试");
    }
  }

  /** 校验并消费：命中即删，错误累计到上限即作废。 */
  public Check check(String rawEmail, String rawCode, String purpose) {
    String mail = rawEmail.toLowerCase();
    try {
      EmailCodeMapper.CodeRow row = codes.latest(mail, purpose);
      if (row == null) {
        return new Check(false, "请先获取邮箱验证码");
      }
      if (toEpochMs(row.getExpiresAt()) < System.currentTimeMillis()) {
        codes.deleteById(row.getId());
        return new Check(false, "验证码已过期，请重新获取");
      }
      String stored = codes.hashOf(row.getId());
      if (stored == null) {
        stored = "";
      }
      if (!codeHash(mail, rawCode.trim()).equals(stored)) {
        if (codes.bumpAttempts(row.getId()) != 1) {
          return new Check(false, "请先获取邮箱验证码");
        }
        Integer after = codes.attemptsOf(row.getId());
        int attempts = after == null ? MAX_ATTEMPTS : after;
        if (attempts >= MAX_ATTEMPTS) {
          return new Check(false, codes.deleteById(row.getId()) == 1
              ? "错误次数过多，验证码已作废，请重新获取" : "请先获取邮箱验证码");
        }
        return new Check(false, "验证码不正确（还可尝试 " + (MAX_ATTEMPTS - attempts) + " 次）");
      }
      if (codes.consume(row.getId(), stored) != 1) {
        return new Check(false, "验证码已被使用，请重新获取");
      }
      return new Check(true, null);
    } catch (RuntimeException e) {
      return new Check(false, "验证码校验失败，请稍后再试");
    }
  }

  /**
   * DATETIME 按 JVM 默认时区解释——与 Node 的 mysql2 同一口径（连接串不改写会话时区）。
   * 两栈若在这里各自换算，"同一枚验证码"会出现一侧有效一侧过期。
   */
  private static long toEpochMs(LocalDateTime value) {
    return value.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
  }
}
