package com.inkstack.mail;

import jakarta.mail.internet.MimeMessage;
import java.util.Map;
import java.util.Properties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Component;

/**
 * 邮件通道，对齐 lib/mailer.ts：凭证全部来自 SMTP_* 配置，<b>未配置即 dev 降级</b>——
 * 不真发，验证码打印到服务端日志并随应答回显 devCode，配好后该字段自动消失。
 *
 * <p>两条防注入约束是原实现用真钱换来的，必须一起搬：Subject/text 先单行化
 * （CR/LF 会改写邮件头与正文结构），HTML 正文再对元字符转义（昵称有三个入口来自
 * 第三方 OAuth 直接回传，不受我方控制）。
 */
@Component
public class Mailer {

  private static final Logger log = LoggerFactory.getLogger(Mailer.class);
  private static final Map<String, String[]> PURPOSE = Map.of(
      "register", new String[] {"注册验证码", "注册验证码"},
      "reset", new String[] {"密码重置验证码", "密码重置验证码"},
      "twofa", new String[] {"两步验证临时码", "两步验证临时码"});

  private final String host;
  private final int port;
  private final String user;
  private final String pass;
  private final String from;

  public Mailer(@Value("${inkstack.mail.host:}") String host,
      @Value("${inkstack.mail.port:465}") int port,
      @Value("${inkstack.mail.user:}") String user,
      @Value("${inkstack.mail.pass:}") String pass,
      @Value("${inkstack.mail.from:}") String from) {
    this.host = host == null ? "" : host.trim();
    this.port = port;
    this.user = user == null ? "" : user.trim();
    this.pass = pass == null ? "" : pass.trim();
    this.from = from == null || from.isBlank()
        ? (this.user.isBlank() ? "墨栈 InkStack" : "墨栈 InkStack <" + this.user + ">")
        : from;
  }

  public boolean configured() {
    return !host.isBlank() && !user.isBlank() && !pass.isBlank();
  }

  /** sent=false 且 devCode 非空表示走了本地降级；error 非空表示真发失败。 */
  public record Result(boolean sent, String devCode, String error) {}

  public Result sendVerifyCode(String email, String code, String purpose) {
    String[] tpl = PURPOSE.getOrDefault(purpose, PURPOSE.get("register"));
    if (!configured()) {
      log.info("[mailer:dev] {} -> {} : {}（10 分钟内有效；配置 SMTP_* 后改走真实邮件）",
          tpl[1], email, code);
      return new Result(false, code, null);
    }
    try {
      send(email,
          "【墨栈】" + tpl[0] + " " + code + "（10 分钟内有效）",
          "你的墨栈" + tpl[1] + "是：" + code + "\n10 分钟内有效。若非本人操作，请忽略本邮件并尽快修改密码。",
          """
          <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;border:2px solid #26221c;">
            <p style="letter-spacing:.2em;color:#8a5a12;font-size:12px;margin:0 0 6px;">INKSTACK · 墨栈</p>
            <h2 style="margin:0 0 12px;">%s</h2>
            <p style="font-size:28px;font-weight:800;letter-spacing:.35em;margin:0 0 12px;">%s</p>
            <p style="color:#6b6355;font-size:13px;margin:0;">10 分钟内有效。若非本人操作，请忽略本邮件并尽快修改密码。</p>
          </div>""".formatted(tpl[1], escHtml(code)));
      return new Result(true, null, null);
    } catch (Exception e) {
      log.error("[mailer] 发送失败：{}", e.getMessage());
      return new Result(false, null, "邮件发送失败，请稍后重试");
    }
  }

  /** 欢迎邮件：失败静默，绝不阻塞注册主流程。 */
  public void sendWelcome(String email, String nickname) {
    String subjectName = oneLine(nickname);
    String htmlName = escHtml(nickname);
    if (!configured()) {
      log.info("[mailer:dev] 欢迎邮件 -> {}（{}）；配置 SMTP_* 后真发", email, subjectName);
      return;
    }
    try {
      send(email,
          "【墨栈】欢迎入驻，" + subjectName + " —— 研墨开查，落笔为栈",
          subjectName + "，欢迎入驻墨栈 InkStack！\n\n这里有三件事值得一试：\n1. 读文章——好稿子值得慢研，付费专栏稿支持作者持续写作；\n2. 提问——每篇文章右侧挂着作者 AI 分身，5 滴墨一问，作者本人的口吻回答；\n3. 写作——创作台支持导入 Markdown，写完投递社区审核即可公开。\n\n书房入口：/study（你的创作与收益都在这里）\n安全中心：/security（改密、两步验证、设备管理）\n\n—— 墨栈 InkStack",
          """
          <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:28px;border:2px solid #26221c;">
            <p style="letter-spacing:.2em;color:#8a5a12;font-size:12px;margin:0 0 6px;">INKSTACK · 墨栈</p>
            <h2 style="margin:0 0 12px;">欢迎入驻，%s</h2>
            <p style="font-size:14px;line-height:1.8;margin:0 0 12px;">研墨开查，落笔为栈。刚来的话，有三件事值得一试：</p>
            <ol style="font-size:14px;line-height:1.9;margin:0 0 12px;padding-left:20px;">
              <li><b>读文章</b>——好稿子值得慢研，付费专栏稿支持作者持续写作；</li>
              <li><b>提问</b>——文章右侧挂着作者 AI 分身，5 滴墨一问，用作者的口吻回答；</li>
              <li><b>写作</b>——创作台支持导入 Markdown，投递社区审核即可公开。</li>
            </ol>
            <p style="font-size:13px;margin:0 0 4px;">书房：<a href="/study" style="color:#8a5a12;">/study</a>（创作与收益都在这里）</p>
            <p style="font-size:13px;margin:0;">安全中心：<a href="/security" style="color:#8a5a12;">/security</a>（改密、两步验证、设备管理）</p>
          </div>""".formatted(htmlName));
    } catch (Exception e) {
      log.error("[mailer] 欢迎邮件发送失败：{}", e.getMessage());
    }
  }

  /** 新设备登录提醒：ua/IP 来自请求头，同样先单行化再进 HTML。 */
  public void sendLoginAlert(String email, String ip, String ua, String time) {
    if (!configured()) {
      return;
    }
    String device = oneLine(ua == null || ua.isBlank() ? "未知" : ua);
    device = device.length() > 120 ? device.substring(0, 120) : device;
    String safeIp = ip == null || ip.isBlank() ? "未知" : oneLine(ip);
    try {
      send(email,
          "【墨栈】安全提醒：你的账号刚在新设备登录",
          "你的墨栈账号于 " + time + " 在新设备登录。\n设备：" + device + "\nIP：" + safeIp
              + "\n若非本人操作，请立即进入 安全中心（/security）修改密码并下线所有设备。",
          """
          <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;border:2px solid #8c2f1b;">
            <p style="letter-spacing:.2em;color:#8c2f1b;font-size:12px;margin:0 0 6px;">INKSTACK · 安全提醒</p>
            <h2 style="margin:0 0 12px;">新设备登录</h2>
            <p style="font-size:14px;margin:0 0 8px;">时间：%s</p>
            <p style="font-size:14px;margin:0 0 8px;">设备：%s</p>
            <p style="font-size:14px;margin:0 0 8px;">IP：%s</p>
            <p style="color:#6b6355;font-size:13px;margin:0;">若非本人操作，请立即进入安全中心（/security）修改密码并下线所有设备。</p>
          </div>""".formatted(escHtml(time), escHtml(device), escHtml(safeIp)));
    } catch (Exception e) {
      log.error("[mailer] 登录提醒发送失败：{}", e.getMessage());
    }
  }

  private void send(String to, String subject, String text, String html) throws Exception {
    JavaMailSenderImpl sender = new JavaMailSenderImpl();
    sender.setHost(host);
    sender.setPort(port);
    sender.setUsername(user);
    sender.setPassword(pass);
    sender.setDefaultEncoding("UTF-8");
    Properties props = sender.getJavaMailProperties();
    props.put("mail.transport.protocol", "smtp");
    // 465 直连 TLS；587 起 STARTTLS。与 Node 的 secure: port === 465 同一条判断。
    props.put("mail.smtp.ssl.enable", String.valueOf(port == 465));
    if (port != 465) {
      props.put("mail.smtp.starttls.enable", "true");
    }
    props.put("mail.smtp.connectiontimeout", "8000");
    props.put("mail.smtp.timeout", "8000");
    props.put("mail.smtp.writetimeout", "8000");

    MimeMessage message = sender.createMimeMessage();
    MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
    helper.setFrom(from);
    helper.setTo(to);
    helper.setSubject(subject);
    helper.setText(text, html);
    sender.send(message);
  }

  /** Subject / text 里绝不允许 CR/LF：一旦放行就是邮件头注入。 */
  static String oneLine(String s) {
    return (s == null ? "" : s).replaceAll("[\\r\\n\\u2028\\u2029]+", " ")
        .replaceAll("\\s{2,}", " ").trim();
  }

  static String escHtml(String s) {
    return (s == null ? "" : s)
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&#39;");
  }
}
