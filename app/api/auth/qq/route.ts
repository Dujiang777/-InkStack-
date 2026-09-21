// GET /api/auth/qq — 发起 QQ 互联 OAuth（connect.qq.com，流程与 Gitee 同构）。
// 凭证未配置（.env 无 QQ_CLIENT_ID/QQ_CLIENT_SECRET）时返回 JSON 提示；
// 配置后 302 跳转 QQ 授权页。state 防 CSRF 与 Gitee/GitHub 版同构。
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  if (!(process.env.QQ_CLIENT_ID && process.env.QQ_CLIENT_SECRET)) {
    return NextResponse.json(
      { ok: false, error: "QQ 登录暂未配置凭证，敬请期待" },
      { status: 503 }
    );
  }
  // state 防 CSRF：随机值写入短时 Cookie，回调时比对
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("qq_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  // v15.2：同 Gitee——反代下 req.url host 落 localhost，redirect_uri 用 NEXT_PUBLIC_SITE_URL
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const redirectUri = new URL("/api/auth/qq/callback", base).toString();
  const authorize = new URL("https://graph.qq.com/oauth2.0/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", process.env.QQ_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  // QQ 互联默认 scope 即含 get_user_info，无需显式声明
  return NextResponse.redirect(authorize.toString());
}
