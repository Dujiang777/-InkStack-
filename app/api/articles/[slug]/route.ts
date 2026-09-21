// PUT    /api/articles/[slug] — 作者编辑文章（普通用户编辑后重新进入待审核；admin 编辑直接通过）
// DELETE /api/articles/[slug] — 作者撤回自己的文章（status → removed，保留数据与积分流水）
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getPool, dbEnabled } from "@/lib/db";
import { notify } from "@/lib/notify";
import { grantCappedReward } from "@/lib/points";
import { ensurePaidColumns, parseDiscount } from "@/lib/data";

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "编辑需要 MySQL" }, { status: 503 });
  const { slug } = await params;
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
    publish?: boolean;
  };
  const title = (body.title ?? "").trim().slice(0, 200);
  const md = (body.md ?? "").trim();
  const summary = (body.summary ?? "").trim().slice(0, 500) || null;
  const tags =
    Array.isArray(body.tags) && body.tags.length
      ? body.tags.slice(0, 6).map((t) => String(t).slice(0, 20))
      : ["创作"];
  const asDraft = body.draft === true;
  const asPublish = body.publish === true;
  // 解锁定价：0 = 免费；允许 0–10000 的整数
  const unlockPrice = Math.max(0, Math.min(10_000, Math.floor(Number(body.unlockPrice) || 0)));
  // 早鸟价：0 < 折扣 < 原价，截止时间最长 30 天；无效则清除折扣
  const discount = parseDiscount(body.discountPrice, body.discountUntil, unlockPrice);
  // 仅发布模式：书房草稿箱一键发布，不带内容更新（正文保持草稿原样）
  const publishOnly = asPublish && !title && !md;

  if (!publishOnly) {
    if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    if (md.length < 10) return NextResponse.json({ error: "正文太短（至少 10 字）" }, { status: 400 });
    if (md.length > 100_000) return NextResponse.json({ error: "正文过长（上限 10 万字）" }, { status: 400 });
  }

  try {
    const [rows] = await pool.query(`SELECT id, author_id, status FROM articles WHERE slug = ? LIMIT 1`, [slug]);
    const art = (rows as { id: number; author_id: number; status: string }[])[0];
    if (!art) return NextResponse.json({ error: "文章不存在" }, { status: 404 });
    if (Number(art.author_id) !== user.id && !isStaff(user.role)) {
      return NextResponse.json({ error: "只能编辑自己的文章" }, { status: 403 });
    }
    const wasDraft = art.status === "draft";
    await ensurePaidColumns(pool);

    if (asDraft) {
      // 存草稿：仅限本身就是草稿的文章（已发布内容不允许绕过审核悄悄修改）
      if (!wasDraft) {
        return NextResponse.json({ error: "已发布/审核中的文章不支持存草稿，请走重新提审" }, { status: 400 });
      }
      await pool.query(
        `UPDATE articles
           SET title = ?, md_content = ?, summary = ?, tags = ?, cover_label = ?, unlock_price = ?,
               discount_price = ?, discount_until = ?
         WHERE id = ?`,
        [title, md, summary, JSON.stringify(tags), (body.coverLabel ?? "").trim().slice(0, 32) || "新稿", unlockPrice, discount[0], discount[1], art.id]
      );
      return NextResponse.json({ ok: true, draft: true });
    }

    // 草稿转正式发布：进入审核流 + 发文奖励（每日上限 1）；其余情况维持原有重审逻辑
    // 普通用户改动后重新进入审核；管理员编辑直接视为通过
    const reviewStatus = isStaff(user.role) ? "approved" : "pending";
    if (publishOnly) {
      await pool.query(
        `UPDATE articles
           SET status = 'published', review_status = ?, review_note = NULL,
               published_at = IF(published_at IS NULL, NOW(), published_at)
         WHERE id = ?`,
        [reviewStatus, art.id]
      );
    } else {
      await pool.query(
        `UPDATE articles
           SET title = ?, md_content = ?, summary = ?, tags = ?, cover_label = ?, unlock_price = ?,
               discount_price = ?, discount_until = ?,
               status = 'published',
               review_status = ?, review_note = NULL,
               published_at = IF(? = 1 AND published_at IS NULL, NOW(), published_at)
         WHERE id = ?`,
        [title, md, summary, JSON.stringify(tags), (body.coverLabel ?? "").trim().slice(0, 32) || "新稿", unlockPrice, discount[0], discount[1], reviewStatus, wasDraft ? 1 : 0, art.id]
      );
    }

    // 草稿首次发布奖励：+20，每日上限 1 篇（失败/超限静默）
    let rewardGranted = 0;
    let capped = false;
    if (wasDraft) {
      const r = await grantCappedReward(user.id, 20, "发布奖励", "publish", 1);
      rewardGranted = r.granted ? 20 : 0;
      capped = Boolean(r.capped);
    }

    // 重新提审 / 草稿发布 → 通知管理员（失败静默）
    if (reviewStatus === "pending") {
      const [admins] = await pool.query(`SELECT id FROM users WHERE role = 'admin' AND banned = 0`);
      for (const a of admins as { id: number }[]) {
        notify(a.id, "review", `《${title}》${wasDraft ? "发布" : "更新"}，等待审核`, `${user.nickname} 提交了文章`, `/admin`);
      }
    }
    return NextResponse.json({
      ok: true,
      reviewStatus,
      reward: rewardGranted,
      capped,
      publishedFromDraft: wasDraft,
    });
  } catch {
    return NextResponse.json({ error: "保存失败（数据库异常）" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { slug } = await params;
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库暂不可用" }, { status: 503 });

  try {
    const [rows] = await pool.query(`SELECT id, author_id, status FROM articles WHERE slug = ? LIMIT 1`, [slug]);
    const art = (rows as { id: number; author_id: number; status: string }[])[0];
    if (!art) return NextResponse.json({ error: "文章不存在" }, { status: 404 });
    if (Number(art.author_id) !== user.id && !isStaff(user.role)) {
      return NextResponse.json({ error: "只能撤回自己的文章" }, { status: 403 });
    }
    if (art.status === "draft") {
      // 草稿硬删除：单事务先清全部外键子行、再删主行。
      // v17.5：原实现是 4 条各自自动提交的语句，且只清了 boosts/tips/likes——
      //   漏了 bookmarks / read_history / comments / series_items / article_purchases。
      //   只要存在任一漏掉的子行（草稿可被收藏、可被评论，见 lib/data.ts 的公开态校验），
      //   `DELETE FROM articles` 就会被外键 RESTRICT 挡下 → 走外层 catch 返 500，
      //   而前 3 条 DELETE 已经提交 → 草稿删不掉、likes/tips/boosts 却被清空的「部分删除」。
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // 表名均为硬编码常量；统一按 article_id 清理，顺序无所谓（同一事务内提交）
        const CHILD_TABLES = [
          "article_boosts",
          "article_tips",
          "article_likes",
          "bookmarks",
          "read_history",
          "comments",
          "series_items",
          "article_purchases",
        ];
        for (const t of CHILD_TABLES) {
          await conn.query(`DELETE FROM ${t} WHERE article_id = ?`, [art.id]);
        }
        await conn.query(`DELETE FROM articles WHERE id = ?`, [art.id]);
        await conn.commit();
      } catch {
        await conn.rollback();
        return NextResponse.json({ error: "撤回失败（数据库异常）" }, { status: 500 });
      } finally {
        conn.release();
      }
      return NextResponse.json({ ok: true, deleted: true });
    }
    await pool.query(`UPDATE articles SET status = 'removed', pinned = 0, featured = 0 WHERE id = ?`, [art.id]);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "撤回失败（数据库异常）" }, { status: 500 });
  }
}
