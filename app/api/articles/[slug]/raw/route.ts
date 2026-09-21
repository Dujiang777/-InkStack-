// GET /api/articles/[slug]/raw — 取文章原文（仅作者本人或管理员，供创作台编辑回填）
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { ensurePaidColumns } from "@/lib/data";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { slug } = await params;
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库暂不可用" }, { status: 503 });

  try {
    await ensurePaidColumns(pool);
    const [rows] = await pool.query(
      `SELECT slug, title, md_content AS md, summary, tags, cover_label AS coverLabel,
              review_status AS reviewStatus, review_note AS reviewNote, author_id, status,
              IFNULL(unlock_price,0) AS unlockPrice,
              IFNULL(discount_price,0) AS discountPrice,
              discount_until AS discountUntil
       FROM articles WHERE slug = ? LIMIT 1`,
      [slug]
    );
    const art = (rows as Record<string, unknown>[])[0];
    if (!art) return NextResponse.json({ error: "文章不存在" }, { status: 404 });
    if (Number(art.author_id) !== user.id && !isStaff(user.role)) {
      return NextResponse.json({ error: "仅作者本人可读取原文" }, { status: 403 });
    }
    return NextResponse.json({
      article: {
        slug: String(art.slug),
        title: String(art.title),
        md: String(art.md ?? ""),
        summary: art.summary ? String(art.summary) : "",
        tags: Array.isArray(art.tags) ? (art.tags as string[]) : [],
        coverLabel: art.coverLabel ? String(art.coverLabel) : "",
        reviewStatus: String(art.reviewStatus ?? "approved"),
        reviewNote: art.reviewNote ? String(art.reviewNote) : null,
        status: String(art.status ?? "published"),
        unlockPrice: Number(art.unlockPrice ?? 0),
        discountPrice: Number(art.discountPrice ?? 0),
        discountUntil: art.discountUntil ? new Date(art.discountUntil as string).toISOString() : null,
      },
    });
  } catch {
    return NextResponse.json({ error: "读取失败" }, { status: 500 });
  }
}
