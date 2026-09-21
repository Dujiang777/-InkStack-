// POST /api/admin/reports — 举报处理（admin 限定）
// body: { reportId, handle: delete_content|keep|dismiss, note? }
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { adminHandleReport, logAdminAction } from "@/lib/data";

const HANDLES = ["delete_content", "keep", "dismiss"] as const;
type Handle = (typeof HANDLES)[number];

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "仅管理团队可操作" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { reportId?: number; handle?: string; note?: string };
  const reportId = Number(body.reportId);
  const handle = body.handle as Handle;
  if (!reportId || !HANDLES.includes(handle)) {
    return NextResponse.json({ error: "参数须为 { reportId, handle: delete_content|keep|dismiss, note? }" }, { status: 400 });
  }

  const result = await adminHandleReport(reportId, handle, body.note);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  logAdminAction(user.id, `report:${handle}`, "report", reportId, body.note ?? undefined);
  return NextResponse.json({ ok: true, reportId, handle });
}
