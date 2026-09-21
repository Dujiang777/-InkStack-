// GET /api/auth/gitee — 发起 Gitee OAuth（国产 Gitee.com，流程与 GitHub 同构）。
// 凭证未配置（.env 无 GITEE_CLIENT_ID/GITEE_CLIENT_SECRET）时返回 JSON 提示；
// 配置后 302 跳转 Gitee 授权页。state 防 CSRF 同 GitHub 版。
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  if (!(process.env.GITEE_CLIENT_ID && process.env.GITEE_CLIENT_SECRET)) {
    return NextResponse.json(
      { ok: false, error: "Gitee 登录暂未配置凭证，敬请期待" },
      { status: 503 }
    );
  }
  // state 防 CSRF：随机值写入短时 Cookie，回调时比对
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("gt_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  // v15.2：生产 next start + 反代下 req.url host 落 localhost，必须用 NEXT_PUBLIC_SITE_URL
  // 拼 redirect_uri（与 Gitee 应用后台配置的回调地址一致），本机开发时才回退 req.url
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const redirectUri = new URL("/api/auth/gitee/callback", base).toString();
  const authorize = new URL("https://gitee.com/oauth/authorize");
  authorize.searchParams.set("client_id", process.env.GITEE_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "user_info emails");
  authorize.searchParams.set("state", state);
  return NextResponse.redirect(authorize.toString());
}
