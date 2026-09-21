// GET /api/auth/qq/callback — QQ 互联回调：code 换 token → 取 openid → 拉取用户资料
// → 以 openid 兜底邮箱 upsert 本地账号 → 写会话 Cookie → 回首页。
// QQ Connect API（graph.qq.com）：
//   GET /oauth2.0/token?grant_type=authorization_code&...&fmt=json   → {access_token,...}
//   GET /oauth2.0/me?access_token=&fmt=json                          → {client_id,openid}
//   GET /user/get_user_info?access_token=&oauth_consumer_key=&openid= → {ret:0,nickname,...}
// QQ 不提供邮箱：用 openid 拼唯一兜底邮箱（openid 对同一应用恒定，账号可复登）。
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPool, dbEnabled } from "@/lib/db";
import { setSessionCookie, cleanNickname } from "@/lib/auth";

function fail(reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?oauth=qq&err=${reason}`, process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100"));
}

export async function GET(req: Request) {
  // v15.2：与发起端一致，redirect_uri 用 NEXT_PUBLIC_SITE_URL 拼（反代下 req.url 落 localhost）
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  if (!(process.env.QQ_CLIENT_ID && process.env.QQ_CLIENT_SECRET)) return fail("disabled");
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const jar = await cookies();
  const savedState = jar.get("qq_oauth_state")?.value ?? "";
  jar.set("qq_oauth_state", "", { httpOnly: true, path: "/", maxAge: 0 });
  if (!code || !state || state !== savedState) return fail("state");

  try {
    // 1) code 换 access_token（fmt=json 拿 JSON；QQ 偶发回 urlencoded，两样都兜）
    const tokenUrl = new URL("https://graph.qq.com/oauth2.0/token");
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    tokenUrl.searchParams.set("client_id", process.env.QQ_CLIENT_ID!);
    tokenUrl.searchParams.set("client_secret", process.env.QQ_CLIENT_SECRET!);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("redirect_uri", new URL("/api/auth/qq/callback", base).toString());
    tokenUrl.searchParams.set("fmt", "json");
    const tokenRes = await fetch(tokenUrl.toString());
    const tokenText = await tokenRes.text();
    let accessToken = "";
    try {
      accessToken = (JSON.parse(tokenText) as { access_token?: string }).access_token ?? "";
    } catch {
      accessToken = new URLSearchParams(tokenText).get("access_token") ?? "";
    }
    if (!accessToken) return fail("token");

    // 2) 取 openid（fmt=json 返回 {client_id, openid}；否则 jsonp 包裹，剥壳兜底）
    const meRes = await fetch(`https://graph.qq.com/oauth2.0/me?access_token=${encodeURIComponent(accessToken)}&fmt=json`);
    const meText = await meRes.text();
    let openid = "";
    try {
      openid = (JSON.parse(meText) as { openid?: string }).openid ?? "";
    } catch {
      const m = meText.match(/"openid"\s*:\s*"([0-9a-fA-F]+)"/);
      openid = m?.[1] ?? "";
    }
    if (!openid) return fail("profile");

    // 3) 拉取昵称等资料（ret=0 才算成功）
    const infoUrl = new URL("https://graph.qq.com/user/get_user_info");
    infoUrl.searchParams.set("access_token", accessToken);
    infoUrl.searchParams.set("oauth_consumer_key", process.env.QQ_CLIENT_ID!);
    infoUrl.searchParams.set("openid", openid);
    const infoRes = await fetch(infoUrl.toString());
    const info = (await infoRes.json()) as { ret?: number; nickname?: string; gender?: string };
    if (info.ret !== 0) return fail("profile");
    // v17.7：第三方返回的昵称不受我方控制 → 统一净化后再入库/发信
    const nickname = cleanNickname(info.nickname || `QQ用户${openid.slice(0, 6)}`);
    const avatarText = nickname.slice(0, 1).toUpperCase();
    // 邮箱兜底：QQ 不给邮箱，openid 对同一应用恒定，可保证唯一键 + 复登同一账号
    const email = `${openid}@qq.noreply.inkstack.dev`;

    if (!dbEnabled()) return fail("db");
    const pool = await getPool();
    if (!pool) return fail("db");

    // 4) upsert：邮箱已存在则登录该账号（同步昵称），否则建档。
    //    密码槽写随机串（OAuth 用户不可用密码登录，可在安全中心改密建立凭据）
    const [ins] = await pool.query(
      `INSERT INTO users (nickname, email, password_hash, avatar_text)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)`,
      [nickname, email, `oauth:${randomBytes(24).toString("hex")}`, avatarText]
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
