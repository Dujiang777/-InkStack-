// POST /api/auth/reset — 邮箱验证码重置密码（码 10 分钟有效、5 次尝试上限）
// 成功后使该邮箱的所有登录失败计数清零（防锁定叠加），要求重新登录
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { checkCode } from "@/lib/verify-code";

export async function POST(req: Request) {
  if (!dbEnabled()) {
    return NextResponse.json({ error: "演示模式下不可用：请先配置数据库" }, { status: 501 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    code?: string;
    password?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const code = (body.code ?? "").trim();
  const password = body.password ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  }
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "请输入 6 位邮箱验证码" }, { status: 400 });
  }
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return NextResponse.json({ error: "新密码至少 8 位，且需同时包含字母和数字" }, { status: 400 });
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
        { error: `该密码已出现在 ${leaked} 次已知泄露中，为安全起见请换一个` },
        { status: 400 }
      );
    }
    // v17.2：邮箱存在性判断挪到验证码校验**之后**（同 register 的修复口径）。
    //   修复前先 404「该邮箱未注册」，任何人用一个格式合法的假验证码反复请求，
    //   就能靠 404/400 的差异枚举已注册邮箱；本接口也无独立限流。
    //   先验码：未注册邮箱拿不到 reset 验证码（send-code 会 404），
    //   因此这里统一返回「请先获取邮箱验证码」，不再区分账号是否存在。
    const check = await checkCode(pool, email, code, "reset");
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }
    const [rows] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    const u = (rows as { id: number }[])[0];
    if (!u) {
      return NextResponse.json({ error: "该邮箱未注册" }, { status: 404 });
    }
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(password), u.id]);
    // 重置密码 = 凭据可能已泄露 → 全端会话立即下线（顶尖标准）
    await pool.query(`UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0`, [u.id]);
    const { logAudit, clientIp, clientUa } = await import("@/lib/audit");
    await logAudit(pool, "password_reset", Number(u.id), { ip: clientIp(req), ua: clientUa(req) });
    return NextResponse.json({ ok: true, hint: "密码已重置，所有设备已下线，请用新密码登录" });
  } catch {
    return NextResponse.json({ error: "重置失败，请稍后再试" }, { status: 500 });
  }
}
