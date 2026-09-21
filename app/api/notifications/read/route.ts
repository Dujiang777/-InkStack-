// POST /api/notifications/read — 标记已读
// body: { id?: number }  传 id 只标记单条；不传则全部已读
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const pool = await getPool();
  if (!pool) return NextResponse.json({ ok: false }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { id?: number };
  const id = Number(body.id);
  try {
    if (Number.isInteger(id) && id > 0) {
      // 限定本人，防越权改他人通知
      const [res] = await pool.query(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [
        id,
        user.id,
      ]);
      const affected = (res as { affectedRows?: number }).affectedRows ?? 0;
      return NextResponse.json({ ok: true, affected });
    }
    await pool.query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [user.id]);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
