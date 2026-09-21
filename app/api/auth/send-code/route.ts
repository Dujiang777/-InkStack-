// POST /api/auth/send-code — 注册邮箱验证码发送（60s 冷却 / 10 分钟 5 次频控；
// SMTP 未配置时 dev 降级：响应带 devCode 便于本地测试，配置后自动真发）
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";
import { smtpConfigured, sendVerifyCode } from "@/lib/mailer";
import { issueCode } from "@/lib/verify-code";
import { clientIp } from "@/lib/audit";
import * as rl from "@/lib/rate-limit";

export async function POST(req: Request) {
  if (!dbEnabled()) {
    return NextResponse.json({ error: "演示模式下不可用：请先配置数据库" }, { status: 501 });
  }
  // IP 维度限流：单 IP 15 分钟内最多 10 次（防换邮箱轰炸发信额度）
  const ipKey = `sendcode-ip:${clientIp(req)}`;
  const v = rl.verdict(ipKey, { max: 10 });
  if (v.locked) {
    return NextResponse.json(
      { error: `操作过于频繁，请约 ${Math.ceil(v.retryAfterSec / 60)} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(v.retryAfterSec) } }
    );
  }
  const body = (await req.json().catch(() => ({}))) as { email?: string; purpose?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const purpose =
    body.purpose === "reset" ? "reset" : body.purpose === "twofa" ? "twofa" : "register";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }
  rl.hit(ipKey, { max: 10 });

  const { getPool } = await import("@/lib/db");
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  try {
    const [dup] = await pool.query("SELECT id, totp_enabled FROM users WHERE email = ? LIMIT 1", [email]);
    const row = (dup as Record<string, unknown>[])[0];
    const exists = Boolean(row);
    if (purpose === "reset" && !exists) {
      // 重置密码：邮箱必须已注册（不泄露注册状态以外的信息）
      return NextResponse.json({ error: "该邮箱未注册" }, { status: 404 });
    }
    if (purpose === "twofa") {
      // 两步验证恢复码：仅发给已注册且已开启 2FA 的邮箱（未开启的不浪费发信额度）
      if (!exists) return NextResponse.json({ error: "该邮箱未注册" }, { status: 404 });
      if (Number(row?.totp_enabled) !== 1) {
        return NextResponse.json({ error: "该邮箱未开启两步验证，直接用密码登录即可" }, { status: 400 });
      }
    }
    if (purpose === "register" && exists) {
      return NextResponse.json({ error: "该邮箱已注册，可直接登录" }, { status: 409 });
    }
    const issued = await issueCode(pool, email, purpose);
    if (!issued.ok) {
      return NextResponse.json({ error: issued.error }, { status: 429 });
    }
    const mail = await sendVerifyCode(email, issued.code, purpose);
    if (mail.error) {
      return NextResponse.json({ error: mail.error }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      // 仅开发环境且 SMTP 未配置时的本地测试通道；生产即使漏配 SMTP 也不回显验证码（v15.0）
      ...(process.env.NODE_ENV !== "production" && !smtpConfigured()
        ? { devCode: issued.code, devHint: "SMTP 未配置，验证码已打印到服务端日志" }
        : {}),
    });
  } catch {
    return NextResponse.json({ error: "发送失败，请稍后再试" }, { status: 500 });
  }
}
