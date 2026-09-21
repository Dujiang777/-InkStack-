// POST /api/articles/[slug]/tip — 墨水打赏：读者花点墨打赏作者，作者得 90%（平台抽成 10%）
// 档位：10 / 50 点墨。禁止给自己的文章打赏。
// v17.3：扣款 + 作者分账 + 双份流水 + 明细落库改为**单事务**（tipArticle），
//        不再用「先扣款事务、再入账事务 + 失败补偿」的两段式（补偿自身失败会永久丢墨）。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";
import { tipArticle, TIP_AMOUNTS, type MoneyFailCode } from "@/lib/data";
import { notify } from "@/lib/notify";

const STATUS: Record<MoneyFailCode, number> = {
  notfound: 404,
  forbidden: 400,
  insufficient: 402,
  server: 500,
};

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能打赏" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "打赏需要 MySQL" }, { status: 503 });
  const { slug } = await params;

  const body = (await req.json().catch(() => ({}))) as { amount?: number };
  const amount = Number(body.amount);
  if (!(TIP_AMOUNTS as readonly number[]).includes(amount)) {
    return NextResponse.json(
      { error: `打赏档位须为 ${TIP_AMOUNTS.join(" 或 ")} 点墨` },
      { status: 400 }
    );
  }

  const r = await tipArticle(slug, user.id, amount);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: STATUS[r.code] });
  }

  // 站内通知作者（成功结果只代表钱已落账；通知失败静默，不影响已完成的打赏）
  notify(
    r.toUserId,
    "tip",
    "收到墨水打赏",
    `${user.nickname} 打赏了 ${r.amount} 点墨，你收到 ${r.authorGot} 点`,
    `/article/${slug}`
  );

  return NextResponse.json({
    ok: true,
    tipped: r.amount,
    authorGot: r.authorGot,
    balance: r.balance,
  });
}
