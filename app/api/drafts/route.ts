// GET /api/drafts?title=xxx — 读取当前用户草稿（无则 404）
// PUT /api/drafts — 保存/覆盖草稿（同名 upsert），创作台自动保存调用
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录，草稿将暂存本地" }, { status: 401 });
  }
  const title = new URL(req.url).searchParams.get("title")?.slice(0, 200) || "";
  const pool = await getPool();
  if (!pool || !title) return NextResponse.json({ draft: null });

  try {
    const [rows] = await pool.query(
      `SELECT content, DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') AS updatedAt
       FROM drafts WHERE user_id = ? AND title = ? LIMIT 1`,
      [user.id, title]
    );
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) return NextResponse.json({ draft: null });
    return NextResponse.json({ draft: { content: String(r.content), updatedAt: String(r.updatedAt) } });
  } catch {
    return NextResponse.json({ error: "草稿读取失败" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录，草稿将暂存本地" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { title?: string; content?: string };
  const title = (body.title ?? "").trim().slice(0, 200);
  const content = body.content ?? "";
  if (!title) return NextResponse.json({ error: "title 不能为空" }, { status: 400 });
  if (content.length > 100_000) {
    return NextResponse.json({ error: "草稿过长（上限 10 万字）" }, { status: 400 });
  }
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库未配置" }, { status: 503 });

  try {
    await pool.query(
      `INSERT INTO drafts (user_id, title, content) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [user.id, title, content]
    );
    const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    return NextResponse.json({ ok: true, savedAt: now });
  } catch {
    return NextResponse.json({ error: "草稿保存失败" }, { status: 500 });
  }
}
