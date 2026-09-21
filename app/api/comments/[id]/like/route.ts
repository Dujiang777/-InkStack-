// POST /api/comments/[id]/like — 评论点赞/取消（toggle），登录用户
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { toggleCommentLike } from "@/lib/data";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能点赞评论" }, { status: 401 });
  const { id } = await params;
  const commentId = Number(id);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return NextResponse.json({ error: "参数无效" }, { status: 400 });
  }
  try {
    const d = await toggleCommentLike(user.id, commentId);
    return NextResponse.json({ ok: true, ...d });
  } catch {
    return NextResponse.json({ error: "点赞失败，请稍后再试" }, { status: 500 });
  }
}
