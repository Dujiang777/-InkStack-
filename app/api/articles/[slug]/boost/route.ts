// POST /api/articles/[slug]/boost — 作者给自己的文章加热：花 80 墨买 24h 信息流加权（可叠加延长）
// v17.3：原实现是「spendPoints 事务提交 → 写 article_boosts」，写库抛异常时最外层 catch
//        直接返回 500，80 点墨既不加热也不退还（静默蒸发）。现改为单事务（boostArticle）。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";
import { boostArticle, type MoneyFailCode } from "@/lib/data";

const STATUS: Record<MoneyFailCode, number> = {
  notfound: 404,
  forbidden: 403,
  insufficient: 402,
  server: 500,
};

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能加热文章" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "加热需要 MySQL" }, { status: 503 });
  const { slug } = await params;

  const r = await boostArticle(slug, user.id);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: STATUS[r.code] });
  }

  return NextResponse.json({
    ok: true,
    cost: r.cost,
    balance: r.balance,
    boostUntil: r.boostUntil,
  });
}
