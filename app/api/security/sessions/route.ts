// /api/security/sessions — 登录设备管理（需登录）
//   GET                        → 列出我的活跃会话（含当前标记）
//   DELETE {id} 或 {all:true}  → 下线指定设备 / 其他所有设备（越权防护：仅能操作自己的会话）
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";
import { getCurrentUser, listSessions, revokeSession, revokeOtherSessions } from "@/lib/auth";
import { logAudit, clientIp, clientUa } from "@/lib/audit";
import { getPool } from "@/lib/db";

export async function GET() {
  if (!dbEnabled()) return NextResponse.json({ error: "演示模式下不可用" }, { status: 501 });
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const sessions = await listSessions(me.id);
  return NextResponse.json({ ok: true, sessions });
}

export async function DELETE(req: Request) {
  if (!dbEnabled()) return NextResponse.json({ error: "演示模式下不可用" }, { status: 501 });
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: number; all?: boolean };
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });

  if (body.all) {
    const n = await revokeOtherSessions(me.id, true);
    await logAudit(pool, "session_revoke", me.id, { ip: clientIp(req), ua: clientUa(req), detail: `下线其他 ${n} 台设备` });
    return NextResponse.json({ ok: true, revoked: n, hint: n > 0 ? `已下线其他 ${n} 台设备` : "没有其他在线设备" });
  }
  if (typeof body.id === "number" && Number.isInteger(body.id)) {
    const ok = await revokeSession(me.id, body.id);
    if (!ok) return NextResponse.json({ error: "会话不存在或已下线" }, { status: 404 });
    await logAudit(pool, "session_revoke", me.id, { ip: clientIp(req), ua: clientUa(req), detail: `下线会话 #${body.id}` });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "参数错误：需要 id 或 all" }, { status: 400 });
}
