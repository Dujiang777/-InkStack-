// GET /api/notifications — 当前用户的通知（最近 30 条）+ 未读数
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const pool = await getPool();
  if (!pool) return NextResponse.json({ notifications: [], unread: 0 });

  try {
    const [rows] = await pool.query(
      `SELECT id, type, title, body, link, is_read AS isRead,
              DATE_FORMAT(created_at,'%m-%d %H:%i') AS createdAt
       FROM notifications WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 30`,
      [user.id]
    );
    const [cnt] = await pool.query(
      `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0`,
      [user.id]
    );
    const notifications = (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      type: String(r.type),
      title: String(r.title),
      body: r.body ? String(r.body) : null,
      link: r.link ? String(r.link) : null,
      isRead: Number(r.isRead) === 1,
      createdAt: String(r.createdAt ?? ""),
    }));
    return NextResponse.json({ notifications, unread: Number((cnt as Record<string, unknown>[])[0]?.unread ?? 0) });
  } catch {
    return NextResponse.json({ notifications: [], unread: 0 });
  }
}
