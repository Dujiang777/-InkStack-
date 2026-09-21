// POST /api/articles/[slug]/unlock — 付费解锁文章：读者付 unlock_price 点墨，作者得 70%（平台 30%）
// 幂等：已购买直接返回成功；作者本人/免费文返回 400 提示。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool, dbEnabled } from "@/lib/db";
import { unlockArticle } from "@/lib/data";
import { notify } from "@/lib/notify";

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能解锁" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "解锁需要 MySQL" }, { status: 503 });
  const { slug } = await params;

  const r = await unlockArticle(slug, user.id);
  if (!r.ok) {
    const status = r.error.includes("不存在")
      ? 404
      : r.error.includes("无需") || r.error.includes("免费")
        ? 400
        : r.error.includes("墨水") || r.error.includes("余额")
          ? 402
          : 500;
    return NextResponse.json({ error: r.error }, { status });
  }
  if (r.price === 0) {
    return NextResponse.json({ ok: true, already: true, message: "已解锁过本文" });
  }

  // 站内通知作者（失败静默）
  const pool = await getPool();
  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT a.author_id, a.title FROM articles a WHERE a.slug = ? LIMIT 1`,
        [slug]
      );
      const art = (rows as { author_id: number; title: string }[])[0];
      if (art) {
        notify(Number(art.author_id), "unlock", "文章被解锁", `${user.nickname} 花费 ${r.price} 点墨解锁《${art.title}》，你到账 ${r.authorGot} 点`, `/article/${slug}`);
      }
    } catch {
      /* 静默 */
    }
  }
  return NextResponse.json({ ok: true, price: r.price, authorGot: r.authorGot, balance: r.balance });
}
