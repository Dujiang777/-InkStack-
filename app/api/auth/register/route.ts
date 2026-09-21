// POST /api/auth/register — 邮箱验证码 + 昵称 + 密码注册（注册即送 100 积分）
// 密码要求：至少 8 位且同时含字母与数字；验证码 10 分钟有效、5 次尝试上限
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";
import { hashPassword, setSessionCookie, cleanNickname } from "@/lib/auth";
import { clientIp, clientUa } from "@/lib/audit";

export async function POST(req: Request) {
  if (!dbEnabled()) {
    return NextResponse.json(
      { error: "演示模式下注册不可用：请先配置 DATABASE_URL 并执行 db/schema.sql" },
      { status: 501 }
    );
  }
  const body = (await req.json().catch(() => ({}))) as {
    nickname?: string;
    email?: string;
    password?: string;
    code?: string;
  };
  // v17.7：昵称统一净化（控制字符/零宽字符）——它会进欢迎邮件的 Subject 与 HTML 正文。
  // 长度校验仍按原始输入判定，错误文案与顺序不变。
  const rawNickname = (body.nickname ?? "").trim();
  const nickname = cleanNickname(rawNickname);
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const code = (body.code ?? "").trim();

  if (!nickname || rawNickname.length > 20) {
    return NextResponse.json({ error: "昵称必填且不超过 20 字" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return NextResponse.json(
      { error: "密码至少 8 位，且需同时包含字母和数字" },
      { status: 400 }
    );
  }
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "请输入 6 位邮箱验证码" }, { status: 400 });
  }

  const { getPool } = await import("@/lib/db");
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  try {
    // 泄露密码检查（HIBP k-匿名；网络异常降级放行）
    const { pwnedCount } = await import("@/lib/pwned");
    const leaked = await pwnedCount(password);
    if (leaked > 0) {
      return NextResponse.json(
        { error: `该密码已出现在 ${leaked} 次已知泄露中，为安全起见请换一个（建议加符号或更长）` },
        { status: 400 }
      );
    }
    // v17.2：邮箱是否已注册的判断挪到验证码校验**之后**。
    //   修复前 dup 检查在 checkCode 之前，任何人用一个格式合法的假验证码（如 000000）
    //   反复打本接口，靠 409/400 的差异就能枚举平台已注册邮箱，且本接口无独立限流。
    //   现在必须先持有发到该邮箱的真实验证码才能走到这一分支
    //   （send-code 对已注册邮箱本就拒绝签发 register 验证码，正常用户不会到这里）。
    // 先验码再建号（失败会消耗尝试次数，防撞库枚举）
    const { checkCode } = await import("@/lib/verify-code");
    const check = await checkCode(pool, email, code, "register");
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }
    const [dup] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if ((dup as unknown[]).length > 0) {
      return NextResponse.json({ error: "该邮箱已注册，可直接登录" }, { status: 409 });
    }
    const [r] = await pool.query(
      "INSERT INTO users (nickname, email, password_hash, avatar_text, role) VALUES (?, ?, ?, ?, 'reader')",
      [nickname, email, hashPassword(password), nickname.slice(0, 1)]
    );
    const uid = Number((r as { insertId: number }).insertId);
    await setSessionCookie(uid, { ip: clientIp(req), ua: clientUa(req) });
    const { logAudit } = await import("@/lib/audit");
    await logAudit(pool, "register", uid, { ip: clientIp(req), ua: clientUa(req), detail: email });
    // 欢迎邮件：异步发送，失败静默不阻塞注册响应
    void import("@/lib/mailer").then((m) => m.sendWelcomeEmail(email, nickname));
    return NextResponse.json({ ok: true, user: { id: uid, nickname } });
  } catch {
    return NextResponse.json({ error: "注册失败，请稍后再试" }, { status: 500 });
  }
}
