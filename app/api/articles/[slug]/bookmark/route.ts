// POST /api/articles/[slug]/bookmark — 收藏/取消收藏（toggle），登录用户
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { toggleBookmark } from "@/lib/data";

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能收藏" }, { status: 401 });
  const { slug } = await params;
  try {
    const d = await toggleBookmark(user.id, slug);
    return NextResponse.json({ ok: true, ...d });
  } catch {
    return NextResponse.json({ error: "收藏失败，请稍后再试" }, { status: 500 });
  }
}
