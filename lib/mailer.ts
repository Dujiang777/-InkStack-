// 邮件发送层：nodemailer SMTP，凭证全部来自环境变量（.env）：
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM（缺省用 SMTP_USER）
// 未配置凭证时进入 DEV 降级：不真发，验证码打印到服务端日志，
// 并仅在响应里附带 devCode 供本地测试（生产配置 SMTP 后该字段自动消失）。
import { createTransport, getTestMessageUrl } from "nodemailer";

/** v17.7：邮件 HTML 正文出口转义。昵称等用户可控值会拼进 HTML 模板，
 *  入口侧已由 lib/auth.ts 的 cleanNickname 过滤控制字符，这里再对 HTML 元字符兜底。 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
/** 单行化：Subject / text 里绝不允许出现 CR/LF（防邮件头与正文结构被改写） */
function oneLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

const FROM =
  process.env.SMTP_FROM || (process.env.SMTP_USER ? `墨栈 InkStack <${process.env.SMTP_USER}>` : "墨栈 InkStack");

const PURPOSE_TEXT: Record<string, { subject: string; label: string }> = {
  register: { subject: "注册验证码", label: "注册验证码" },
  reset: { subject: "密码重置验证码", label: "密码重置验证码" },
  twofa: { subject: "两步验证临时码", label: "两步验证临时码" },
};

/** 发送验证码邮件（purpose 区分注册/重置模板）。返回 { sent } 或降级时 { devCode }。 */
export async function sendVerifyCode(
  email: string,
  code: string,
  purpose = "register"
): Promise<{ sent: boolean; devCode?: string; error?: string }> {
  const tpl = PURPOSE_TEXT[purpose] ?? PURPOSE_TEXT.register;
  if (!smtpConfigured()) {
    // DEV 降级：日志可见，响应带 devCode 便于本地测试
    console.log(`[mailer:dev] ${tpl.label} -> ${email} : ${code}（10 分钟内有效；配置 SMTP_* 后改走真实邮件）`);
    return { sent: false, devCode: code };
  }
  try {
    const port = Number(process.env.SMTP_PORT || 465);
    const transport = createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 465 直连 TLS；587 走 STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const info = await transport.sendMail({
      from: FROM,
      to: email,
      subject: `【墨栈】${tpl.subject} ${code}（10 分钟内有效）`,
      text: `你的墨栈${tpl.label}是：${code}\n10 分钟内有效。若非本人操作，请忽略本邮件并尽快修改密码。`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;border:2px solid #26221c;">
  <p style="letter-spacing:.2em;color:#8a5a12;font-size:12px;margin:0 0 6px;">INKSTACK · 墨栈</p>
  <h2 style="margin:0 0 12px;">${tpl.label}</h2>
  <p style="font-size:28px;font-weight:800;letter-spacing:.35em;margin:0 0 12px;">${code}</p>
  <p style="color:#6b6355;font-size:13px;margin:0;">10 分钟内有效。若非本人操作，请忽略本邮件并尽快修改密码。</p>
</div>`,
    });
    const testUrl = getTestMessageUrl(info);
    if (testUrl) console.log(`[mailer] 测试预览: ${testUrl}`);
    return { sent: true };
  } catch (e) {
    console.error("[mailer] 发送失败:", e instanceof Error ? e.message : e);
    return { sent: false, error: "邮件发送失败，请稍后重试" };
  }
}

/** 注册欢迎邮件（营销/引导；失败静默，不阻塞注册主流程） */
export async function sendWelcomeEmail(email: string, nickname: string): Promise<void> {
  // v17.7：昵称可控 → Subject/text 单行化、HTML 正文转义（防头注入与 HTML 注入）
  const safeSubject = oneLine(nickname);
  const safeHtml = escHtml(nickname);
  if (!smtpConfigured()) {
    console.log(`[mailer:dev] 欢迎邮件 -> ${email}（${safeSubject}）；配置 SMTP_* 后真发`);
    return;
  }
  try {
    const port = Number(process.env.SMTP_PORT || 465);
    const transport = createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from: FROM,
      to: email,
      subject: `【墨栈】欢迎入驻，${safeSubject} —— 研墨开查，落笔为栈`,
      text: `${safeSubject}，欢迎入驻墨栈 InkStack！\n\n这里有三件事值得一试：\n1. 读文章——好稿子值得慢研，付费专栏稿支持作者持续写作；\n2. 提问——每篇文章右侧挂着作者 AI 分身，5 滴墨一问，作者本人的口吻回答；\n3. 写作——创作台支持导入 Markdown，写完投递社区审核即可公开。\n\n书房入口：/study（你的创作与收益都在这里）\n安全中心：/security（改密、两步验证、设备管理）\n\n—— 墨栈 InkStack`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:28px;border:2px solid #26221c;">
  <p style="letter-spacing:.2em;color:#8a5a12;font-size:12px;margin:0 0 6px;">INKSTACK · 墨栈</p>
  <h2 style="margin:0 0 12px;">欢迎入驻，${safeHtml}</h2>
  <p style="font-size:14px;line-height:1.8;margin:0 0 12px;">研墨开查，落笔为栈。刚来的话，有三件事值得一试：</p>
  <ol style="font-size:14px;line-height:1.9;margin:0 0 12px;padding-left:20px;">
    <li><b>读文章</b>——好稿子值得慢研，付费专栏稿支持作者持续写作；</li>
    <li><b>提问</b>——文章右侧挂着作者 AI 分身，5 滴墨一问，用作者的口吻回答；</li>
    <li><b>写作</b>——创作台支持导入 Markdown，投递社区审核即可公开。</li>
  </ol>
  <p style="font-size:13px;margin:0 0 4px;">书房：<a href="/study" style="color:#8a5a12;">/study</a>（创作与收益都在这里）</p>
  <p style="font-size:13px;margin:0;">安全中心：<a href="/security" style="color:#8a5a12;">/security</a>（改密、两步验证、设备管理）</p>
</div>`,
    });
  } catch (e) {
    console.error("[mailer] 欢迎邮件发送失败:", e instanceof Error ? e.message : e);
  }
}

/** 新设备登录提醒（安全通知；失败静默，不阻塞登录） */
export async function sendLoginAlert(
  email: string,
  meta: { ip?: string; ua?: string; time: string }
): Promise<void> {
  if (!smtpConfigured()) return;
  try {
    const port = Number(process.env.SMTP_PORT || 465);
    const transport = createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from: FROM,
      to: email,
      subject: `【墨栈】安全提醒：你的账号刚在新设备登录`,
      text: `你的墨栈账号于 ${meta.time} 在新设备登录。\n设备：${(meta.ua ?? "未知").slice(0, 120)}\nIP：${meta.ip ?? "未知"}\n若非本人操作，请立即进入 安全中心（/security）修改密码并下线所有设备。`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;border:2px solid #8c2f1b;">
  <p style="letter-spacing:.2em;color:#8c2f1b;font-size:12px;margin:0 0 6px;">INKSTACK · 安全提醒</p>
  <h2 style="margin:0 0 12px;">新设备登录</h2>
  <p style="font-size:14px;margin:0 0 8px;">时间：${meta.time}</p>
  <p style="font-size:14px;margin:0 0 8px;">设备：${(meta.ua ?? "未知").slice(0, 120)}</p>
  <p style="font-size:14px;margin:0 0 12px;">IP：${meta.ip ?? "未知"}</p>
  <p style="color:#6b6355;font-size:13px;margin:0;">若非本人操作，请立即进入安全中心（/security）修改密码并下线所有设备。</p>
</div>`,
    });
  } catch (e) {
    console.error("[mailer] 登录提醒发送失败:", e instanceof Error ? e.message : e);
  }
}
