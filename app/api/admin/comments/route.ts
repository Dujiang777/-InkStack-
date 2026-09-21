// POST /api/admin/comments — 评论管理（admin/developer 限定）
// body: { commentId, action: "delete" } —— 删除评论及其一级回复，回扣文章评论计数
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { adminDeleteComment, logAdminAction } from "@/lib/data";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "仅管理团队可操作" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { commentId?: number; action?: string };
  const commentId = Number(body.commentId);
  if (!commentId || body.action !== "delete") {
    return NextResponse.json({ error: "参数须为 { commentId, action: 'delete' }" }, { status: 400 });
  }

  const r = await adminDeleteComment(commentId);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  logAdminAction(user.id, "comment:delete", "comment", commentId, `删除 ${r.removed ?? 1} 条`);
  return NextResponse.json({ ok: true, removed: r.removed });
}
