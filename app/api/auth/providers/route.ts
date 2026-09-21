// GET /api/auth/providers — 前端探测各家 OAuth 凭证配置情况（多供应商）
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    gitee: Boolean(process.env.GITEE_CLIENT_ID && process.env.GITEE_CLIENT_SECRET),
    qq: Boolean(process.env.QQ_CLIENT_ID && process.env.QQ_CLIENT_SECRET),
  });
}
