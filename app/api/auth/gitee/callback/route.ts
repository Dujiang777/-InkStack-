// GET /api/auth/gitee/callback — Gitee 回调：code 换 token → 拉取用户资料
// → 以 Gitee 邮箱 upsert 本地账号 → 写会话 Cookie → 回首页。
// Gitee API v5：POST /oauth/token（JSON, grant_type=authorization_code）
//               GET /api/v5/user?access_token=  GET /api/v5/emails?access_token=
// 邮箱常为私密：优先取 /emails 里的主邮箱，否则用 noreply 兜底保证唯一键。
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPool, dbEnabled } from "@/lib/db";
import { setSessionCookie, cleanNickname } from "@/lib/auth";

function fail(reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?oauth=gitee&err=${reason}`, process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100"));
}

export async function GET(req: Request) {
  // v15.2：与发起端一致，redirect_uri 用 NEXT_PUBLIC_SITE_URL 拼（req.url 在反代下落 localhost）
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  if (!(process.env.GITEE_CLIENT_ID && process.env.GITEE_CLIENT_SECRET)) return fail("disabled");
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const jar = await cookies();
  const savedState = jar.get("gt_oauth_state")?.value ?? "";
  jar.set("gt_oauth_state", "", { httpOnly: true, path: "/", maxAge: 0 });
  if (!code || !state || state !== savedState) return fail("state");

  try {
    // 1) code 换 access_token（Gitee 要求 grant_type 字段）
    const tokenRes = await fetch("https://gitee.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITEE_CLIENT_ID,
        client_secret: process.env.GITEE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: new URL("/api/auth/gitee/callback", base).toString(),
      }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) return fail("token");

    // 2) 拉取 Gitee 用户 + 邮箱列表（Gitee 邮箱多为私密，两路都试）
    const auth = encodeURIComponent(tokenData.access_token);
    const [userRes, emailRes] = await Promise.all([
      fetch(`https://gitee.com/api/v5/user?access_token=${auth}`),
      fetch(`https://gitee.com/api/v5/emails?access_token=${auth}`).catch(() => null),
    ]);
    const ge = (await userRes.json()) as {
      login?: string; name?: string; bio?: string | null; id?: number; email?: string | null;
    };
    if (!ge.login || !ge.id) return fail("profile");
    let primaryEmail = typeof ge.email === "string" ? ge.email : "";
    if (emailRes?.ok) {
      try {
        const list = (await emailRes.json()) as { email: string; primary?: boolean; verified?: boolean }[];
        // v15.0：只信「primary 且 verified===true」的邮箱（对齐 GitHub 回调），
        // 未验证/未公开的邮箱一律不采信，走 noreply 兜底，防止用未验证邮箱接管同邮箱本地账号
        const hit = list.find((e) => e.primary && e.verified === true);
        if (hit?.email) primaryEmail = hit.email;
      } catch {
        /* 邮箱接口不可用则走兜底 */
      }
    }
    if (typeof ge.email === "string" && ge.email && !emailRes?.ok) {
      // profile 邮箱仅在没有 emails 接口佐证时才可能采信，Gitee profile 邮箱一律视为未验证
      primaryEmail = "";
    }
    // 邮箱兜底：保证本地唯一键（Gitee 未公开邮箱时无法真实取到）
    const email = primaryEmail || `${ge.id}+${ge.login}@users.noreply.gitee.com`;
    // v17.7：第三方返回的昵称不受我方控制 → 统一净化后再入库/发信
    const nickname = cleanNickname(ge.name || ge.login);
    const avatarText = nickname.slice(0, 1).toUpperCase();
    const bio = (ge.bio ?? "").slice(0, 250);

    if (!dbEnabled()) return fail("db");
    const pool = await getPool();
    if (!pool) return fail("db");

    // 3) upsert：邮箱已存在则登录该账号（同步昵称/简介），否则建档。
    //    密码槽写随机串（OAuth 用户不可用密码登录，可在安全中心改密建立凭据）
    const [ins] = await pool.query(
      `INSERT INTO users (nickname, email, password_hash, avatar_text, bio)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), bio = IF(bio IS NULL OR bio = '', VALUES(bio), bio)`,
      [nickname, email, `oauth:${randomBytes(24).toString("hex")}`, avatarText, bio]
    );
    let uid = Number((ins as { insertId?: number }).insertId ?? 0);
    if (!uid) {
      const [q] = await pool.query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
      uid = Number((q as { id?: number }[])[0]?.id ?? 0);
    }
    if (!uid) return fail("db");
    // 新建档才发欢迎邮件（insertId > 0 即新建；已存在账号走登录不发）
    if (Number((ins as { insertId?: number }).insertId ?? 0) > 0) {
      void import("@/lib/mailer").then((m) => m.sendWelcomeEmail(email, nickname));
    }
    await setSessionCookie(uid);
    return NextResponse.redirect(new URL("/", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100"));
  } catch {
    return fail("network");
  }
}
