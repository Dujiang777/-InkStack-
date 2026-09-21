// PATCH /api/me/password — 修改密码（旧密码校验 + 新密码强度），改完强制重登录
// v17.1 安全对齐：与 /api/security/password 统一策略——旧密码爆破限流、
// 字母+数字强度门槛、泄露库（HIBP k-匿名）检查，并落审计日志。
import { NextResponse } from "next/server";
import { getCurrentUser, hashPassword, verifyPassword, revokeOtherSessions } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { logAudit, clientIp, clientUa } from "@/lib/audit";
import { pwnedCount } from "@/lib/pwned";
import * as rl from "@/lib/rate-limit";

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  // 防爆破：会话被盗后不能靠这个接口无限试旧密码（与安全中心改密同一限流键）
  const ip = clientIp(req);
  const key = `pwdchg:${user.id}:${ip}`;
  if (rl.verdict(key).locked) {
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as { oldPassword?: string; newPassword?: string };
  const oldPw = body.oldPassword ?? "";
  const newPw = body.newPassword ?? "";

  if (newPw.length < 8 || !/[a-zA-Z]/.test(newPw) || !/[0-9]/.test(newPw)) {
    return NextResponse.json({ error: "新密码至少 8 位，且需同时包含字母和数字" }, { status: 400 });
  }
  if (newPw === oldPw) {
    return NextResponse.json({ error: "新密码不能与旧密码相同" }, { status: 400 });
  }

  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  try {
    const [rows] = await pool.query(`SELECT password_hash FROM users WHERE id = ? LIMIT 1`, [user.id]);
    const r = (rows as { password_hash?: string }[])[0];
    if (!r || !verifyPassword(oldPw, String(r.password_hash ?? ""))) {
      const after = rl.hit(key);
      await logAudit(pool, "password_change", user.id, { ip, ua: clientUa(req), detail: "旧密码错误" });
      return NextResponse.json({ error: `旧密码不正确（还可尝试 ${5 - after.fails} 次）` }, { status: 401 });
    }
    rl.clear(key);

    // 泄露密码检查（网络异常 fail-open，不阻塞改密主流程）
    const leaked = await pwnedCount(newPw);
    if (leaked > 0) {
      return NextResponse.json(
        { error: `新密码已出现在 ${leaked} 次已知泄露中，请换一个（建议加符号或更长）` },
        { status: 400 }
      );
    }

    await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashPassword(newPw), user.id]);
    // v15.0：改密后下线其他设备（被盗会话不能靠旧 cookie 存活）
    const revoked = await revokeOtherSessions(user.id, true);
    await logAudit(pool, "password_change", user.id, {
      ip,
      ua: clientUa(req),
      detail: `成功，下线 ${revoked} 台其他设备`,
    });
    return NextResponse.json({ ok: true, revoked });
  } catch {
    return NextResponse.json({ error: "修改失败（数据库异常）" }, { status: 500 });
  }
}
