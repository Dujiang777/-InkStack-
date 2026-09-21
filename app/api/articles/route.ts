// GET  /api/articles — 文章列表
// POST /api/articles — 发布文章（创作台/编辑器用；Markdown 原文入库，渲染层统一消毒）
// 积分规则：发布 +20，每日上限 1 篇（防灌水；迁移导入不计入该奖励）
import { NextResponse } from "next/server";
import { listArticles, ensurePaidColumns, parseDiscount } from "@/lib/data";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getPool, dbEnabled } from "@/lib/db";
import { makeSlug } from "@/lib/importer";
import { grantCappedReward } from "@/lib/points";

export async function GET() {
  const articles = await listArticles();
  return NextResponse.json({ articles });
}

async function slugTaken(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>, slug: string) {
  const [rows] = await pool.query("SELECT 1 FROM articles WHERE slug = ? LIMIT 1", [slug]);
  return Array.isArray(rows) && rows.length > 0;
}

async function uniqueSlug(
  pool: NonNullable<Awaited<ReturnType<typeof getPool>>>,
  base: string
): Promise<string> {
  let candidate = base;
  let i = 2;
  while (await slugTaken(pool, candidate)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

/**
 * v17.9：slug 撞唯一键就换号重试。
 *
 * 原实现是 `uniqueSlug()`（SELECT 判重）之后**裸 INSERT**，两条语句之间无锁：
 * 并发发布同名标题时多个请求会算出同一个 slug（中文标题一律回退为 `bo-日期-1`），
 * 后到者撞 `articles.slug` 唯一键抛 ER_DUP_ENTRY，被最外层 catch 吞成 500
 * 「发布失败（数据库异常）」——用户以为发布失败，其实已有一篇落库，重试即产生重复稿。
 * 实测 8 并发同名发布 → 7×500 / 1×200。
 * 现在：命中唯一键冲突即重新分配后缀重试（上限 5 次），其它错误照旧抛出。
 */
type NewArticleRow = {
  authorId: number;
  base: string;
  title: string;
  md: string;
  summary: string | null;
  coverLabel: string;
  tags: string[];
  unlockPrice: number;
  discountPrice: number | null;
  discountUntil: string | null;
  asDraft: boolean;
  reviewStatus: string;
};

async function insertArticleRetrySlug(
  pool: NonNullable<Awaited<ReturnType<typeof getPool>>>,
  row: NewArticleRow
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const slug = await uniqueSlug(pool, row.base);
    try {
      if (row.asDraft) {
        await pool.query(
          `INSERT INTO articles
             (author_id, slug, title, md_content, summary, cover_label, tags, status, review_status, unlock_price, discount_price, discount_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'approved', ?, ?, ?)`,
          [
            row.authorId, slug, row.title, row.md, row.summary, row.coverLabel,
            JSON.stringify(row.tags), row.unlockPrice, row.discountPrice, row.discountUntil,
          ]
        );
      } else {
        await pool.query(
          `INSERT INTO articles
             (author_id, slug, title, md_content, summary, cover_label, tags, status, review_status, unlock_price, discount_price, discount_until, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, NOW())`,
          [
            row.authorId, slug, row.title, row.md, row.summary, row.coverLabel,
            JSON.stringify(row.tags), row.reviewStatus, row.unlockPrice, row.discountPrice, row.discountUntil,
          ]
        );
      }
      return slug;
    } catch (e) {
      if ((e as { code?: string }).code === "ER_DUP_ENTRY" && attempt < 8) {
        // 抖动退避：并发请求会「同步」地重算出同一个空位，不加抖动就会反复对撞
        // （实测 8 并发不加抖动时第 6 次重试仍可能全部落空）
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20) * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "登录后才能发布文章" }, { status: 401 });
  }
  if (!dbEnabled()) {
    return NextResponse.json({ error: "发布需要 MySQL（当前为演示模式）" }, { status: 503 });
  }
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库暂不可用" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    md?: string;
    summary?: string;
    tags?: string[];
    coverLabel?: string;
    unlockPrice?: number;
    discountPrice?: number;
    discountUntil?: string | null;
    draft?: boolean;
  };
  const title = (body.title ?? "").trim().slice(0, 200);
  const md = (body.md ?? "").trim();
  const summary = (body.summary ?? "").trim().slice(0, 500) || null;
  const tags = Array.isArray(body.tags) && body.tags.length
    ? body.tags.slice(0, 6).map((t) => String(t).slice(0, 20))
    : ["创作"];
  const asDraft = body.draft === true;
  // 解锁定价：0 = 免费；允许 0–10000 的整数
  const unlockPrice = Math.max(0, Math.min(10_000, Math.floor(Number(body.unlockPrice) || 0)));
  // 早鸟价：0 < 折扣 < 原价，截止时间最长 30 天；无效则不设折扣
  const discount = parseDiscount(body.discountPrice, body.discountUntil, unlockPrice);

  if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
  if (md.length < 10) return NextResponse.json({ error: "正文太短（至少 10 字）" }, { status: 400 });
  if (md.length > 100_000) return NextResponse.json({ error: "正文过长（上限 10 万字）" }, { status: 400 });

  try {
    await ensurePaidColumns(pool);
    // 审核流：普通用户发文 → 待审核（审核通过后公开展示）；管理员发文直接通过
    // 草稿：仅作者可见，不入审核流、不发奖励（status enum 原生含 'draft'）
    const slug = await insertArticleRetrySlug(pool, {
      authorId: user.id,
      base: makeSlug(title, 1),
      title,
      md,
      summary,
      coverLabel: (body.coverLabel ?? "").trim().slice(0, 32) || "新稿",
      tags,
      unlockPrice,
      discountPrice: discount[0],
      discountUntil: discount[1],
      asDraft,
      reviewStatus: isStaff(user.role) ? "approved" : "pending",
    });
    if (asDraft) return NextResponse.json({ ok: true, draft: true, slug });
  } catch {
    return NextResponse.json({ error: "发布失败（数据库异常）" }, { status: 500 });
  }

  // 发布奖励：+20，每日上限 1 篇（失败/超限静默，不阻塞发布结果）
  const reward = await grantCappedReward(user.id, 20, "发布奖励", "publish", 1);
  return NextResponse.json({
    ok: true,
    reviewPending: !isStaff(user.role),
    reward: reward.granted ? 20 : 0,
    capped: Boolean(reward.capped),
    balance: reward.balance,
  });
}
