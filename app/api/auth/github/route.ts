// GET /api/auth/github — 发起 GitHub OAuth。
// 凭证未配置（.env 无 GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET）时返回 JSON 提示，
// 前端据此展示「暂未配置」气泡；配置后即 302 跳转 GitHub 授权页。
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  if (!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)) {
    return NextResponse.json(
      { ok: false, error: "GitHub 登录暂未配置凭证，敬请期待" },
      { status: 503 }
    );
  }
  // state 防 CSRF：随机值写入短时 Cookie，回调时比对
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("gh_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  const redirectUri = new URL("/api/auth/github/callback", req.url).toString();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "read:user user:email");
  authorize.searchParams.set("state", state);
  return NextResponse.redirect(authorize.toString());
}
