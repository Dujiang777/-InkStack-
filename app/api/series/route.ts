// POST /api/series — 新建专栏（登录用户）
// GET  /api/series — 公开合集架（"我的专栏"在 /api/series/mine，见下方注释）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createSeries, listSeries } from "@/lib/data";

/**
 * 合集架。这条 GET 曾经返回"我的专栏"（书房管理器在用），而 Java 的同一条一直是公开架——
 * 切流只有前缀粒度，于是整个 /api/series 被这一处歧义钉住。现在两条 URL 各管一件事：
 * 这里是架，"我的"在 /api/series/mine。返回体与参数取值必须与 Java 的 SeriesReadController 同式。
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  // Number(null)=0 会被 || 判成假 → 缺省与非数字都回 60；夹到 1..200 与 Java 同一串算式
  const limit = Math.max(1, Math.min(200, Math.floor(Number(sp.get("limit")) || 60)));
  const author = Number(sp.get("author"));
  const cards = await listSeries(limit, Number.isInteger(author) && author !== 0 ? author : undefined);
  return NextResponse.json({ series: cards });
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
