// GET /api/series/mine — 我的专栏（书房管理器与发布台的专栏选择器在用）
//
// 这一条原来长在 GET /api/series 上，而 Java 的 GET /api/series 是公开合集架：
// 同一个 URL 两栈不同义，切流又是前缀粒度，整个 /api/series 因此切不过去。
// 现在两条 URL 各管一件事，两栈同语义，返回体与 401 姿势必须与 Java 的
// SeriesReadController.mine 逐字节一致（{ok, series}，未登录 401 而不是空列表——
// 把"会话没解析出来"报成"你还没有专栏"是谎报）。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listMySeries } from "@/lib/data";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ ok: true, series: await listMySeries(user.id) });
}
