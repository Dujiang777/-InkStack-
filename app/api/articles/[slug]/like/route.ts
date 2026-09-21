// POST /api/articles/[slug]/like — 点赞 / 取消点赞（toggle），计数与关系行同事务同步
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool, dbEnabled } from "@/lib/db";
import { notify } from "@/lib/notify";

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能点赞" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "点赞需要 MySQL" }, { status: 503 });
  const { slug } = await params;
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库暂不可用" }, { status: 503 });

  try {
    const [rows] = await pool.query(
      `SELECT id, author_id, title FROM articles WHERE slug = ? AND status = 'published' LIMIT 1`,
      [slug]
    );
    const art = (rows as { id: number; author_id: number; title: string }[])[0];
    if (!art) return NextResponse.json({ error: "文章不存在" }, { status: 404 });

    const conn = await pool.getConnection();
    let liked: boolean;
    try {
      await conn.beginTransaction();
      const [ex] = await conn.query(
        `SELECT 1 FROM article_likes WHERE user_id = ? AND article_id = ? FOR UPDATE`,
        [user.id, art.id]
      );
      const exists = (ex as Record<string, unknown>[]).length > 0;
      if (exists) {
        await conn.query(`DELETE FROM article_likes WHERE user_id = ? AND article_id = ?`, [user.id, art.id]);
        await conn.query(`UPDATE articles SET like_count = GREATEST(0, like_count - 1) WHERE id = ?`, [art.id]);
        liked = false;
      } else {
        await conn.query(`INSERT INTO article_likes (user_id, article_id) VALUES (?, ?)`, [user.id, art.id]);
        await conn.query(`UPDATE articles SET like_count = like_count + 1 WHERE id = ?`, [art.id]);
        liked = true;
      }
      const [after] = await conn.query(`SELECT like_count FROM articles WHERE id = ?`, [art.id]);
      const likeCount = Number((after as Record<string, unknown>[])[0]?.like_count ?? 0);
      await conn.commit();
      if (liked && Number(art.author_id) !== user.id) {
        notify(Number(art.author_id), "like", `「${art.title}」收到了一个赞`, `${user.nickname} 赞了你的文章`, `/article/${slug}`);
      }
      return NextResponse.json({ ok: true, liked, likeCount });
    } catch {
      await conn.rollback();
      return NextResponse.json({ error: "点赞失败，请稍后再试" }, { status: 500 });
    } finally {
      conn.release();
    }
  } catch {
    return NextResponse.json({ error: "点赞失败，请稍后再试" }, { status: 500 });
  }
}
