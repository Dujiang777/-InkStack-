// GET /api/auth/github/status — 前端探测 GitHub OAuth 是否已配置凭证
import { NextResponse } from "next/server";

export async function GET() {
  const enabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  return NextResponse.json({ ok: true, enabled });
}
