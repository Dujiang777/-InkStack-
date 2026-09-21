// POST /api/history — 记录阅读足迹（登录用户；游客静默忽略）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { recordRead } from "@/lib/data";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: true, skipped: true });
  let slug = "";
  try {
    const body = (await req.json()) as { slug?: unknown };
    slug = typeof body.slug === "string" ? body.slug.trim() : "";
  } catch {
    /* 忽略非法 body */
  }
  if (!slug || slug.length > 200) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  await recordRead(user.id, slug);
  return NextResponse.json({ ok: true });
}
