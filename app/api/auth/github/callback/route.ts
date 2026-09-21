// GET /api/auth/github/callback — GitHub 回调：code 换 token → 拉取用户资料
// → 以 GitHub 邮箱 upsert 本地账号 → 写会话 Cookie → 回首页。
// 凭证未配置或任何一步失败：302 回 /login 并带错误参数。
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPool, dbEnabled } from "@/lib/db";
import { setSessionCookie, cleanNickname } from "@/lib/auth";

function fail(reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?oauth=github&err=${reason}`, process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100"));
}

export async function GET(req: Request) {
  if (!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)) return fail("disabled");
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const jar = await cookies();
  const savedState = jar.get("gh_oauth_state")?.value ?? "";
  jar.set("gh_oauth_state", "", { httpOnly: true, path: "/", maxAge: 0 });
  if (!code || !state || state !== savedState) return fail("state");

  try {
    // 1) code 换 access_token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: new URL("/api/auth/github/callback", req.url).toString(),
      }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) return fail("token");

    // 2) 拉取 GitHub 用户 + 主邮箱
    const ghHeaders = {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "inkstack",
    };
    const [userRes, emailRes] = await Promise.all([
      fetch("https://api.github.com/user", { headers: ghHeaders }),
      fetch("https://api.github.com/user/emails", { headers: ghHeaders }),
    ]);
    const gh = (await userRes.json()) as { login?: string; name?: string; bio?: string | null; id?: number };
    const emails = emailRes.ok
      ? ((await emailRes.json()) as { email: string; primary: boolean; verified: boolean }[])
      : [];
    const primaryEmail = emails.find((e) => e.primary && e.verified)?.email;
    if (!gh.login || !gh.id) return fail("profile");
    // 邮箱取 GitHub 主邮箱；未授权邮箱时用 noreply 地址兜底（保证本地唯一键）
    const email = primaryEmail ?? `${gh.id}+${gh.login}@users.noreply.github.com`;
    // v17.7：第三方返回的昵称不受我方控制 → 统一净化后再入库/发信
    const nickname = cleanNickname(gh.name || gh.login);
    const avatarText = nickname.slice(0, 1).toUpperCase();
    const bio = (gh.bio ?? "").slice(0, 250);

    if (!dbEnabled()) return fail("db");
    const pool = await getPool();
    if (!pool) return fail("db");

    // 3) upsert：邮箱已存在则登录该账号（同步昵称/简介，不覆盖头像字），否则建档
    //    密码槽写随机串（OAuth 用户不可用密码登录，走 /me 改密前无凭据）
    const [ins] = await pool.query(
      `INSERT INTO users (nickname, email, password_hash, avatar_text, bio)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), bio = IF(bio IS NULL OR bio = '', VALUES(bio), bio)`,
      [nickname, email, `oauth:${randomBytes(24).toString("hex")}`, avatarText, bio]
    );
    // ON DUPLICATE KEY 下 insertId 为 0，需回查
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
