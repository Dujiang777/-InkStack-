// POST /api/series/[id]/bundle — 打包解锁整个专栏（一口价，按购买时点篇目快照分摊 70/30）
// v17.5：状态码收口。原来所有非「积分不足」的失败一律 400——包括真正的服务端故障
//   （写库抛异常 / 数据库不可用），客户端会当作用户输入错误而不重试，监控也看不到 5xx。
//   现按 MoneyFailCode 映射，并补上 dbEnabled() 降级守卫（与 unlock / tip / boost 三条链路一致）。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";
import { bundleUnlock, type MoneyFailCode } from "@/lib/data";

const STATUS: Record<MoneyFailCode, number> = {
  notfound: 404,
  forbidden: 400,
  insufficient: 402,
  server: 500,
};

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "打包解锁需要 MySQL" }, { status: 503 });
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "专栏不存在" }, { status: 404 });
  try {
    const r = await bundleUnlock(id, user.id);
    if (!r.ok) {
      return NextResponse.json({ error: r.error }, { status: STATUS[r.code] ?? 500 });
    }
    return NextResponse.json({ ...r, ok: true });
  } catch {
    return NextResponse.json({ error: "打包解锁失败，请稍后再试" }, { status: 500 });
  }
}
