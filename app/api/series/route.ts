// POST /api/series — 新建专栏（登录用户）
// GET  /api/series — 我的专栏列表（书房管理器拉取）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createSeries, listMySeries } from "@/lib/data";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const series = await listMySeries(user.id);
  return NextResponse.json({ ok: true, series });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能开专栏" }, { status: 401 });
  let body: { title?: string; description?: string };
  try {
    body = (await req.json()) as { title?: string; description?: string };
  } catch {
    return NextResponse.json({ error: "请求格式有误" }, { status: 400 });
  }
  const title = (body.title ?? "").trim();
  if (title.length < 2 || title.length > 60) {
    return NextResponse.json({ error: "专栏题名需 2-60 字" }, { status: 400 });
  }
  try {
    const id = await createSeries(user.id, title, (body.description ?? "").trim());
    if (!id) return NextResponse.json({ error: "创建失败，请稍后再试" }, { status: 500 });
    return NextResponse.json({ ok: true, id });
  } catch {
    return NextResponse.json({ error: "创建失败，请稍后再试" }, { status: 500 });
  }
}
