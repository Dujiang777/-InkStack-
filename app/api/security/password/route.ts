// POST /api/security/password — 已登录改密：需旧密码 + 新密码过泄露库检查
// 成功后下线其他所有设备（当前会话保留）
import { NextResponse } from "next/server";
import { dbEnabled, getPool } from "@/lib/db";
import { getCurrentUser, verifyPassword, hashPassword, revokeOtherSessions } from "@/lib/auth";
import { logAudit, clientIp, clientUa } from "@/lib/audit";
import { pwnedCount } from "@/lib/pwned";
import * as rl from "@/lib/rate-limit";

export async function POST(req: Request) {
  if (!dbEnabled()) return NextResponse.json({ error: "演示模式下不可用" }, { status: 501 });
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  // 改密也防爆破（防会话被盗后暴力试旧密码）
  const ip = clientIp(req);
  const key = `pwdchg:${me.id}:${ip}`;
  if (rl.verdict(key).locked) {
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as { oldPassword?: string; newPassword?: string };
  const oldPw = body.oldPassword ?? "";
  const newPw = body.newPassword ?? "";
  if (newPw.length < 8 || !/[a-zA-Z]/.test(newPw) || !/[0-9]/.test(newPw)) {
    return NextResponse.json({ error: "新密码至少 8 位，且需同时包含字母和数字" }, { status: 400 });
  }

  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  try {
    const [rows] = await pool.query("SELECT password_hash FROM users WHERE id = ? LIMIT 1", [me.id]);
    const r = (rows as Record<string, unknown>[])[0];
    if (!r || !verifyPassword(oldPw, String(r.password_hash))) {
      const after = rl.hit(key);
      await logAudit(pool, "password_change", me.id, { ip, ua: clientUa(req), detail: "旧密码错误" });
      return NextResponse.json(
        { error: `旧密码不正确（还可尝试 ${5 - after.fails} 次）` },
        { status: 401 }
      );
    }
    rl.clear(key);
    const leaked = await pwnedCount(newPw);
    if (leaked > 0) {
      return NextResponse.json({ error: `新密码已出现在 ${leaked} 次已知泄露中，请换一个` }, { status: 400 });
    }
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(newPw), me.id]);
    const revoked = await revokeOtherSessions(me.id, true);
    await logAudit(pool, "password_change", me.id, { ip, ua: clientUa(req), detail: `成功，下线 ${revoked} 台其他设备` });
    return NextResponse.json({ ok: true, revoked, hint: revoked > 0 ? `已下线其他 ${revoked} 台设备` : "密码已更新" });
  } catch {
    return NextResponse.json({ error: "操作失败，请稍后再试" }, { status: 500 });
  }
}
