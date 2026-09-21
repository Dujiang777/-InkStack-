// POST /api/auth/login — 邮箱密码登录（v13.5）
// 防爆破：同 邮箱+IP 15 分钟内 5 次失败锁定；2FA：TOTP 或一次性备份码
// 审计：login_ok / login_fail / login_2fa 全留痕；新设备登录触发邮件提醒
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";
import { verifyPassword, setSessionCookie } from "@/lib/auth";
import { verifyTotp, sha256Hex as h } from "@/lib/totp";
import { checkCode } from "@/lib/verify-code";
import { logAudit, clientIp, clientUa } from "@/lib/audit";
import { sendLoginAlert } from "@/lib/mailer";
import * as rl from "@/lib/rate-limit";

export async function POST(req: Request) {
  if (!dbEnabled()) {
    return NextResponse.json(
      { error: "演示模式下登录不可用：请先配置 DATABASE_URL 并执行 db/schema.sql" },
      { status: 501 }
    );
  }
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    totp?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const totp = (body.totp ?? "").trim();
  const ip = clientIp(req);
  const ua = clientUa(req);
  const key = `login:${email}:${ip}`;

  // 先查锁：锁定中直接拒绝（不透露账号是否存在）
  const v = rl.verdict(key);
  if (v.locked) {
    const min = Math.ceil(v.retryAfterSec / 60);
    return NextResponse.json(
      { error: `尝试次数过多，账号已临时锁定，请约 ${min} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(v.retryAfterSec) } }
    );
  }

  const { getPool } = await import("@/lib/db");
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  try {
    const { ensureSecurityTables } = await import("@/lib/auth");
    await ensureSecurityTables(pool);
    const [rows] = await pool.query(
      "SELECT id, nickname, email, password_hash, totp_secret, totp_enabled, totp_backup FROM users WHERE email = ? LIMIT 1",
      [email]
    );
    const u = (rows as Record<string, unknown>[])[0];
    if (!u || !verifyPassword(password, String(u.password_hash))) {
      const after = rl.hit(key);
      const hint = after.locked ? `，账号已临时锁定 15 分钟` : `（还可尝试 ${5 - after.fails} 次）`;
      await logAudit(pool, "login_fail", u ? Number(u.id) : null, { ip, ua, detail: `密码错误: ${email}` });
      return NextResponse.json({ error: `邮箱或密码不正确${hint}` }, { status: 401 });
    }
    const uid = Number(u.id);
    const nickname = String(u.nickname);

    // —— 2FA：已开启则必须提供 TOTP 码或一次性备份码 ——
    if (Number(u.totp_enabled) === 1 && u.totp_secret) {
      if (!totp) {
        // 密码正确但缺验证码：让前端进入第二段（不记失败、不发码）
        return NextResponse.json({ need2fa: true, email });
      }
      let ok = verifyTotp(String(u.totp_secret), totp);
      if (!ok) {
        // 尝试一次性备份码：命中即焚
        let backup: string[] = [];
        try {
          backup = JSON.parse(String(u.totp_backup ?? "[]")) as string[];
        } catch {
          backup = [];
        }
        const hash = h(totp.toUpperCase());
        if (backup.includes(hash)) {
          ok = true;
          const rest = backup.filter((x) => x !== hash);
          await pool.query(`UPDATE users SET totp_backup = ? WHERE id = ?`, [JSON.stringify(rest), uid]);
          await logAudit(pool, "login_2fa", uid, { ip, ua, detail: "备份码登录（已焚毁 1 枚）" });
        }
      }
      if (!ok) {
        // 验证器丢失的兜底：邮箱临时码（send-code purpose=twofa 签发）校验
        const rec = await checkCode(pool, email, totp, "twofa");
        if (rec.ok) {
          ok = true;
          await logAudit(pool, "login_2fa", uid, { ip, ua, detail: "邮箱临时码恢复登录（验证器丢失通道）" });
        }
      }
      if (!ok) {
        const after = rl.hit(key);
        const hint = after.locked ? `，账号已临时锁定 15 分钟` : `（还可尝试 ${5 - after.fails} 次）`;
        await logAudit(pool, "login_2fa", uid, { ip, ua, detail: "验证码错误" });
        return NextResponse.json({ error: `两步验证码不正确${hint}`, need2fa: true }, { status: 401 });
      }
    }

    rl.clear(key);

    // —— 设备识别：是否「新设备」登录（此前无同 UA 的有效会话） ——
    const [prior] = await pool.query(
      `SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND ua = ? AND revoked = 0`,
      [uid, ua.slice(0, 250)]
    );
    const isNewDevice = Number((prior as { c: number }[])[0]?.c ?? 0) === 0;

    await setSessionCookie(uid, { ip, ua });
    await logAudit(pool, "login_ok", uid, { ip, ua });
    if (isNewDevice) {
      // 新设备提醒（静默失败，不阻塞登录）
      sendLoginAlert(String(u.email), {
        ip,
        ua,
        time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true, user: { id: uid, nickname } });
  } catch {
    return NextResponse.json({ error: "登录失败，请稍后再试" }, { status: 500 });
  }
}
