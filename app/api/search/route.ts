// GET /api/search?q= — 全站搜索 JSON 接口（游客可用，供外部/未来客户端调用）
// v17.2：传入当前用户，付费墙在 searchArticles 内生效——
//        未解锁的付费文不参与正文检索、也不回传正文摘录（防匿名拖取付费内容）
import { NextResponse } from "next/server";
import { searchArticles } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ error: "关键词至少 2 个字" }, { status: 400 });
  }
  const viewer = await getCurrentUser();
  const rows = await searchArticles(q, 20, viewer?.id ?? null);
  return NextResponse.json({ ok: true, keyword: q, count: rows.length, results: rows });
}
