// GET  /api/articles/[slug]/comments — 评论列表
// POST /api/articles/[slug]/comments — 发表评论（登录用户自动绑定账号，游客走昵称）
// 积分规则：登录评论 +1（每日上限 3 次）；文章被评论作者 +2（每日上限 10 次，自己评自己不发）
import { NextResponse } from "next/server";
import { listComments, addComment } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { grantCappedReward } from "@/lib/points";
import { notify } from "@/lib/notify";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getCurrentUser();
  const comments = await listComments(slug, user?.id ?? null);
  return NextResponse.json({ comments });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    nickname?: string;
    content?: string;
    parentId?: number | null;
  };
  const user = await getCurrentUser(); // 登录则绑定账号，昵称以账号为准
  const parentId = Number(body.parentId) > 0 ? Number(body.parentId) : null;
  const result = await addComment(
    slug,
    { nickname: body.nickname ?? "", content: body.content ?? "", parentId },
    user ? { id: user.id, nickname: user.nickname } : undefined
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const pool = await getPool();

  // 组装真实评论行返回给前端（前端用它替换占位行，保证点赞/回复可用）
  let commentRow: Record<string, unknown> | null = null;
  if (result.id) {
    let parentAuthor: string | null = null;
    if (parentId && pool) {
      try {
        const [pr] = await pool.query(
          `SELECT COALESCE(u.nickname, c.guest_nickname, '访客') AS nickname
             FROM comments c LEFT JOIN users u ON u.id = c.user_id
            WHERE c.id = ? LIMIT 1`,
          [parentId]
        );
        parentAuthor = (pr as { nickname: string }[])[0]?.nickname ?? null;
      } catch {
        /* 查父评论昵称失败不影响主流程 */
      }
    }
    commentRow = {
      id: result.id,
      nickname: user?.nickname ?? (body.nickname?.trim().slice(0, 20) || "访客"),
      content: (body.content ?? "").trim(),
      createdAt: result.createdAt ?? new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-"),
      parentId,
      parentAuthor,
      likes: 0,
      viewerLiked: false,
    };
  }

  /* ---------- 行为奖励（失败静默：奖励不阻塞评论主流程） ---------- */
  const rewards: { commentator?: number; author?: number } = {};
  if (pool) {
    try {
      const [rows] = await pool.query(
        "SELECT id, author_id FROM articles WHERE slug = ? LIMIT 1",
        [slug]
      );
      const art = (rows as { id: number; author_id: number }[])[0];
      if (art) {
        if (user) {
          const c = await grantCappedReward(user.id, 1, "评论互动", "comment", 3);
          if (c.granted) rewards.commentator = 1;
        }
        const authorId = Number(art.author_id);
        if (authorId && (!user || authorId !== user.id)) {
          const a = await grantCappedReward(authorId, 2, "文章被评论", "comment_received", 10);
          if (a.granted) rewards.author = 2;
          // 站内通知作者（失败静默）
          notify(authorId, "comment", "文章收到新评论", `${user?.nickname ?? "访客"} 参与了讨论`, `/article/${slug}`);
        }
        // 回复目标是被评论的人（非作者本人）时，单独通知 ta（失败静默）
        if (parentId) {
          try {
            const [pRows] = await pool.query(
              `SELECT c.user_id FROM comments c WHERE c.id = ? AND c.user_id IS NOT NULL LIMIT 1`,
              [parentId]
            );
            const pUser = (pRows as { user_id: number }[])[0]?.user_id;
            if (pUser && pUser !== user?.id && pUser !== authorId) {
              notify(pUser, "comment", "有人回复了你的评论", `${user?.nickname ?? "访客"} 回复了你`, `/article/${slug}`);
            }
          } catch {
            /* 回复通知失败静默 */
          }
        }
      }
    } catch {
      /* 奖励失败不影响评论 */
    }
  }

  return NextResponse.json({ ok: true, asUser: Boolean(user), rewards, comment: commentRow });
}
