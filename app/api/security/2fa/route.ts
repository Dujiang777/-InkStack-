// /api/security/2fa — TOTP 双因素认证管理（需登录）
//   POST   {}                     → 生成密钥，返回 secret + otpauth 链接（待验证态）
//   PUT    {code}                 → 验证 6 位码后正式开启，返回 10 枚一次性备份码（仅此一次可见）
//   DELETE {password, code}       → 校验密码 + 当前 TOTP 码后关闭 2FA
import { NextResponse } from "next/server";
import { dbEnabled, getPool } from "@/lib/db";
import { getCurrentUser, verifyPassword } from "@/lib/auth";
import { generateTotpSecret, verifyTotp, otpauthUrl, generateBackupCodes } from "@/lib/totp";
import { logAudit, clientIp, clientUa } from "@/lib/audit";
import * as rl from "@/lib/rate-limit";

export async function POST(req: Request) {
  if (!dbEnabled()) return NextResponse.json({ error: "演示模式下不可用" }, { status: 501 });
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  const [rows] = await pool.query("SELECT totp_enabled FROM users WHERE id = ? LIMIT 1", [me.id]);
  const u = (rows as Record<string, unknown>[])[0];
  if (!u) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (Number(u.totp_enabled) === 1) {
    return NextResponse.json({ error: "两步验证已开启，如需重置请先关闭" }, { status: 400 });
  }
  const secret = generateTotpSecret();
  await pool.query(`UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?`, [secret, me.id]);
  return NextResponse.json({
    ok: true,
    secret,
    otpauth: otpauthUrl(secret, me.email),
    hint: "用验证器 App 扫码或手动输入密钥，然后输入 6 位验证码完成开启",
  });
}

export async function PUT(req: Request) {
  if (!dbEnabled()) return NextResponse.json({ error: "演示模式下不可用" }, { status: 501 });
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const ip = clientIp(req);
  const key = `2fa-setup:${me.id}:${ip}`;
  if (rl.verdict(key).locked) {
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const code = (body.code ?? "").trim();
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  const [rows] = await pool.query("SELECT totp_secret, totp_enabled FROM users WHERE id = ? LIMIT 1", [me.id]);
  const u = (rows as Record<string, unknown>[])[0];
  if (!u || !u.totp_secret) return NextResponse.json({ error: "请先生成密钥（第一步）" }, { status: 400 });
  if (Number(u.totp_enabled) === 1) return NextResponse.json({ error: "两步验证已开启" }, { status: 400 });
  if (!verifyTotp(String(u.totp_secret), code)) {
    const after = rl.hit(key);
    return NextResponse.json({ error: `验证码不正确（还可尝试 ${5 - after.fails} 次）` }, { status: 401 });
  }
  rl.clear(key);
  const { plain, hashed } = generateBackupCodes();
  await pool.query(`UPDATE users SET totp_enabled = 1, totp_backup = ? WHERE id = ?`, [JSON.stringify(hashed), me.id]);
  await logAudit(pool, "totp_enable", me.id, { ip, ua: clientUa(req) });
  return NextResponse.json({
    ok: true,
    backupCodes: plain,
    hint: "两步验证已开启！备份码仅显示这一次，请抄写在安全的地方",
  });
}

export async function DELETE(req: Request) {
  if (!dbEnabled()) return NextResponse.json({ error: "演示模式下不可用" }, { status: 501 });
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const ip = clientIp(req);
  const key = `2fa-off:${me.id}:${ip}`;
  if (rl.verdict(key).locked) {
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { password?: string; code?: string };
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  const [rows] = await pool.query("SELECT password_hash, totp_secret, totp_enabled FROM users WHERE id = ? LIMIT 1", [me.id]);
  const u = (rows as Record<string, unknown>[])[0];
  if (!u) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  if (Number(u.totp_enabled) !== 1) return NextResponse.json({ error: "两步验证未开启" }, { status: 400 });
  if (!verifyPassword(body.password ?? "", String(u.password_hash))) {
    const after = rl.hit(key);
    return NextResponse.json({ error: `密码不正确（还可尝试 ${5 - after.fails} 次）` }, { status: 401 });
  }
  if (!verifyTotp(String(u.totp_secret), body.code ?? "")) {
    const after = rl.hit(key);
    return NextResponse.json({ error: `验证码不正确（还可尝试 ${5 - after.fails} 次）` }, { status: 401 });
  }
  rl.clear(key);
  await pool.query(`UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_backup = NULL WHERE id = ?`, [me.id]);
  await logAudit(pool, "totp_disable", me.id, { ip, ua: clientUa(req) });
  return NextResponse.json({ ok: true, hint: "两步验证已关闭" });
}
