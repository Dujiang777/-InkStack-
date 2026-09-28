// Node 侧读 SQL 的**遗留实现**（P7e′ 起）。
//
// 这个文件是从 lib/data.ts 里整体搬出来的，一个字没改（只去掉了分流语句）。搬进来而不是删掉，
// 是因为 app/api/** 里还有 `route.ts` 在直接调这些函数：把读 SQL 当场删掉，那些还没切走的接口
// 就会在 Node 进程里悄悄去打 Java——对拍闸门（1/3）于是变成"Java 和自己比"，而恰恰是它们在给
// 剩下的路由层把关。所以双轨期的分工是：**页面取数只剩 Java 一条路，Node 读 SQL 集中在这一个文件、
// 只剩路由层一个消费方**。P7f 删掉 Node 路由时，这个文件跟着一起删——那时它是死代码，
// grep 一句就能证明（"还有谁 import 了 data-legacy"）。
//
// ⚠ 新代码不要往这里加东西，也不要在页面里 import 它。
import { getPool } from "./db";
import { demoArticles, demoComments } from "./demo-data";
import {
  dateOnly, demoToCommentRows, demoToRow, effectiveUnlockPrice, gravity, rankHot, weeklyFmt,
} from "./data";
import type {
  ArticleRow, ArticleSeriesNav, ArticleTipRow, AuthorArticleStat, AuthorProfile, BookmarkRow, CommentRow,
  FollowPeer, FollowStats, FootprintArticle, FunnelRow, HistoryRow, HotRange, MyArticleRow, MyCommentRow,
  MySeries, MyStats, SearchResultRow, SeriesCard, SeriesDetail, UnlockIncome, WeeklyReport,
} from "./data";

export async function listArticles(): Promise<ArticleRow[]> {
  const pool = await getPool();
  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT a.slug, a.title, u.nickname AS author, u.avatar_text AS authorAvatar,
                a.author_id AS authorId,
                a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
                a.read_count AS readCount, a.comment_count AS commentCount,
                a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
                DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
                (SELECT MAX(b.boost_until) FROM article_boosts b
                  WHERE b.article_id = a.id AND b.boost_until > NOW()) AS boostUntil,
                (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t
                  WHERE t.article_id = a.id) AS tipTotal,
                IFNULL(a.unlock_price,0) AS unlockPrice,
                IFNULL(a.discount_price,0) AS discountPrice,
                a.discount_until AS discountUntil
         FROM articles a JOIN users u ON u.id = a.author_id
         WHERE a.status = 'published' AND a.review_status = 'approved'
         ORDER BY
           a.pinned DESC,
           /* 加热中的文章仅次于运营置顶，压过自然重力排序 */
           EXISTS(SELECT 1 FROM article_boosts b
                  WHERE b.article_id = a.id AND b.boost_until > NOW()) DESC,
           /* 重力排序（HN 式）：互动热度 / 时间衰减^1.2，把「新鲜 + 有讨论」的文章顶上来 */
           /* v15.2：GREATEST 钳制底数 ≥ 1——published_at 晚于 NOW() 时幂运算为负会导致整条 SQL 报错（ER_DATA_OUT_OF_RANGE），首页曾因此整页降级到 demo 数据 */
           (LOG10(a.read_count + a.comment_count * 5 + a.agent_qa_count * 10 + 10))
           / POWER(GREATEST(TIMESTAMPDIFF(HOUR, a.published_at, NOW()) + 2, 1), 1.2)
         DESC LIMIT 50`
      );
      if (Array.isArray(rows) && rows.length > 0) {
        return (rows as Record<string, unknown>[]).map((r) => ({
          slug: String(r.slug),
          title: String(r.title),
          author: String(r.author),
          authorAvatar: String(r.authorAvatar),
          authorId: r.authorId ? Number(r.authorId) : undefined,
          summary: String(r.summary ?? ""),
          coverLabel: String(r.coverLabel ?? ""),
          tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
          readCount: Number(r.readCount),
          commentCount: Number(r.commentCount),
          agentQaCount: Number(r.agentQaCount),
          publishedAt: dateOnly(r.publishedAt),
          md: "",
          likeCount: Number(r.likeCount ?? 0),
          boostUntil: r.boostUntil ? new Date(r.boostUntil as string).toISOString() : null,
          tipTotal: Number(r.tipTotal ?? 0),
          unlockPrice: Number(r.unlockPrice ?? 0),
          discountPrice: Number(r.discountPrice ?? 0),
          discountUntil: r.discountUntil ? new Date(r.discountUntil as string).toISOString() : null,
        }));
      }
    } catch {
      // 数据库不可用 → 降级
    }
  }
  return demoArticles.map(demoToRow).sort((a, b) => gravity(b) - gravity(a));
}

export async function listByTag(tag: string, limit = 50): Promise<ArticleRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, u.nickname AS author, u.avatar_text AS authorAvatar,
              a.author_id AS authorId,
              a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
              a.read_count AS readCount, a.comment_count AS commentCount,
              a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
              DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
              (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t
                WHERE t.article_id = a.id) AS tipTotal
       FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
         AND JSON_CONTAINS(a.tags, ?)
       ORDER BY a.published_at DESC LIMIT ?`,
      [`"${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`, limit]
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      author: String(r.author),
      authorAvatar: String(r.authorAvatar),
      authorId: r.authorId ? Number(r.authorId) : undefined,
      summary: String(r.summary ?? ""),
      coverLabel: String(r.coverLabel ?? ""),
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      readCount: Number(r.readCount),
      commentCount: Number(r.commentCount),
      agentQaCount: Number(r.agentQaCount),
      publishedAt: dateOnly(r.publishedAt),
      md: "",
      likeCount: Number(r.likeCount ?? 0),
      tipTotal: Number(r.tipTotal ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function randomArticleSlug(exclude = ""): Promise<string | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.query(
      `SELECT slug FROM articles
       WHERE status = 'published' AND review_status = 'approved' AND slug != ?
       ORDER BY RAND() LIMIT 1`,
      [exclude.trim()]
    );
    return (rows as { slug?: string }[])[0]?.slug ?? null;
  } catch {
    return null;
  }
}

export async function getArticle(
  slug: string,
  viewer?: { id?: number | null; privileged?: boolean },
  opts?: { includeMd?: boolean }
): Promise<ArticleRow | null> {
  const pool = await getPool();
  const viewerId = viewer?.id ?? null;
  const privileged = Boolean(viewer?.privileged);
  // includeMd=false：只回正文前 6 行（付费墙试读即止），杜绝全文经任何通道（含 dev 调试流）外泄
  const includeMd = opts?.includeMd !== false;
  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT a.slug, a.title, u.nickname AS author, u.avatar_text AS authorAvatar,
                COALESCE(u.avatar_tone,'') AS authorTone, COALESCE(u.avatar_shape,'') AS authorShape,
                a.author_id AS authorId, a.review_status AS reviewStatus, a.review_note AS reviewNote,
                a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
                a.read_count AS readCount, a.comment_count AS commentCount,
                a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
                ${includeMd ? "a.md_content AS md" : "SUBSTRING_INDEX(a.md_content, '\\n', 6) AS md"},
                IFNULL(a.unlock_price,0) AS unlockPrice,
                IFNULL(a.discount_price,0) AS discountPrice,
                a.discount_until AS discountUntil,
                (SELECT COUNT(*) FROM article_purchases pc WHERE pc.article_id = a.id) AS unlockCount,
                DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
                (SELECT MAX(b.boost_until) FROM article_boosts b
                  WHERE b.article_id = a.id AND b.boost_until > NOW()) AS boostUntil,
                (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t
                  WHERE t.article_id = a.id) AS tipTotal,
                ${viewerId ? "EXISTS(SELECT 1 FROM article_likes l WHERE l.article_id = a.id AND l.user_id = ?)" : "FALSE"} AS viewerLiked,
                ${viewerId ? `IF(a.author_id = ? OR ?, TRUE, EXISTS(SELECT 1 FROM article_purchases p WHERE p.article_id = a.id AND p.user_id = ?))` : "FALSE"} AS viewerUnlocked
         FROM articles a JOIN users u ON u.id = a.author_id
         WHERE a.slug = ? AND a.status = 'published'
           AND (a.review_status = 'approved'
                ${viewerId ? "OR a.author_id = ?" : ""}
                ${privileged ? "OR TRUE" : ""})
         LIMIT 1`,
        viewerId ? [viewerId, viewerId, privileged ? 1 : 0, viewerId, slug, viewerId] : [slug]
      );
      const r = (rows as Record<string, unknown>[])[0];
      if (r) {
        return {
          slug: String(r.slug),
          title: String(r.title),
          author: String(r.author),
          authorAvatar: String(r.authorAvatar),
          authorTone: String(r.authorTone ?? ""),
          authorShape: String(r.authorShape ?? ""),
          summary: String(r.summary ?? ""),
          coverLabel: String(r.coverLabel ?? ""),
          tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
          readCount: Number(r.readCount),
          commentCount: Number(r.commentCount),
          agentQaCount: Number(r.agentQaCount),
          publishedAt: dateOnly(r.publishedAt),
          md: String(r.md ?? ""),
          authorId: Number(r.authorId),
          likeCount: Number(r.likeCount ?? 0),
          reviewStatus: (r.reviewStatus as ArticleRow["reviewStatus"]) ?? "approved",
          reviewNote: r.reviewNote ? String(r.reviewNote) : null,
          viewerLiked: Number(r.viewerLiked ?? 0) === 1,
          viewerUnlocked: Number(r.viewerUnlocked ?? 0) === 1,
          unlockPrice: Number(r.unlockPrice ?? 0),
          discountPrice: Number(r.discountPrice ?? 0),
          discountUntil: r.discountUntil ? new Date(r.discountUntil as string).toISOString() : null,
          unlockCount: Number(r.unlockCount ?? 0),
          boostUntil: r.boostUntil ? new Date(r.boostUntil as string).toISOString() : null,
          tipTotal: Number(r.tipTotal ?? 0),
        };
      }
      return null;
    } catch {
      // 数据库异常 → 落到下方演示数据兜底
    }
  }
  const all = await listArticles();
  return all.find((a) => a.slug === slug) ?? null;
}

export async function listArticleTips(slug: string, limit = 6): Promise<ArticleTipRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT u.nickname, u.avatar_text, t.amount,
              DATE_FORMAT(t.created_at, '%m-%d %H:%i') AS createdAt
       FROM article_tips t
       JOIN users u ON u.id = t.from_user
       JOIN articles a ON a.id = t.article_id
       WHERE a.slug = ?
       ORDER BY t.created_at DESC
       LIMIT ?`,
      [slug, limit]
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      fromName: String(r.nickname),
      fromAvatar: String(r.avatar_text),
      amount: Number(r.amount),
      createdAt: String(r.createdAt),
    }));
  } catch {
    return [];
  }
}

export async function listMyArticles(userId: number): Promise<{ rows: MyArticleRow[]; stats: MyStats }> {
  const pool = await getPool();
  if (!pool)
    return { rows: [], stats: { published: 0, totalReads: 0, totalLikes: 0, tipIncome: 0, totalQa: 0, drafts: 0 } };
  const [rows] = await pool.query(
    `SELECT slug, title, status,
            review_status AS reviewStatus, review_note AS reviewNote,
            read_count AS readCount, like_count AS likeCount, comment_count AS commentCount,
            agent_qa_count AS agentQaCount,
            (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t WHERE t.article_id = a.id) AS tipTotal,
            (SELECT MAX(b.boost_until) FROM article_boosts b
              WHERE b.article_id = a.id AND b.boost_until > NOW()) AS boostUntil,
            DATE_FORMAT(updated_at,'%m-%d %H:%i') AS updatedAt
     FROM articles a WHERE author_id = ?
     ORDER BY updated_at DESC LIMIT 100`,
    [userId]
  );
  const [s] = await pool.query(
    `SELECT
       COUNT(*) AS published,
       IFNULL(SUM(read_count),0) AS totalReads,
       IFNULL(SUM(like_count),0) AS totalLikes,
       IFNULL(SUM(agent_qa_count),0) AS totalQa,
       (SELECT COUNT(*) FROM articles WHERE author_id = ? AND status = 'draft') AS drafts,
       (SELECT IFNULL(SUM(amount),0) FROM article_tips WHERE to_user = ?) AS tipIncome
     FROM articles WHERE author_id = ? AND status = 'published' AND review_status = 'approved'`,
    [userId, userId, userId]
  );
  const sr = (s as Record<string, unknown>[])[0] ?? {};
  if (!Array.isArray(rows))
    return { rows: [], stats: { published: 0, totalReads: 0, totalLikes: 0, tipIncome: 0, totalQa: 0, drafts: 0 } };
  return {
    rows: (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      status: String(r.status),
      reviewStatus: String(r.reviewStatus ?? "approved"),
      reviewNote: r.reviewNote ? String(r.reviewNote) : null,
      readCount: Number(r.readCount ?? 0),
      likeCount: Number(r.likeCount ?? 0),
      commentCount: Number(r.commentCount ?? 0),
      agentQaCount: Number(r.agentQaCount ?? 0),
      tipTotal: Number(r.tipTotal ?? 0),
      boostUntil: r.boostUntil ? new Date(r.boostUntil as string).toISOString() : null,
      updatedAt: String(r.updatedAt ?? "—"),
    })),
    stats: {
      published: Number(sr.published ?? 0),
      totalReads: Number(sr.totalReads ?? 0),
      totalLikes: Number(sr.totalLikes ?? 0),
      tipIncome: Number(sr.tipIncome ?? 0),
      totalQa: Number(sr.totalQa ?? 0),
      drafts: Number(sr.drafts ?? 0),
    },
  };
}

export async function listComments(slug: string, viewerId?: number | null): Promise<CommentRow[]> {
  const pool = await getPool();
  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT c.id,
                COALESCE(u.nickname, c.guest_nickname, '访客') AS nickname,
                c.content,
                c.parent_id AS parentId,
                COALESCE(pu.nickname, p.guest_nickname, '楼层') AS parentAuthor,
                DATE_FORMAT(c.created_at,'%Y-%m-%d %H:%i') AS createdAt,
                c.user_id AS userId,
                COALESCE(u.avatar_text, '') AS avatarText,
                COALESCE(u.avatar_tone, '') AS avatarTone,
                COALESCE(u.avatar_shape, '') AS avatarShape,
                (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS likes,
                ${viewerId ? "EXISTS(SELECT 1 FROM comment_likes v WHERE v.comment_id = c.id AND v.user_id = ?)" : "0"} AS viewerLiked
         FROM comments c
         JOIN articles a ON a.id = c.article_id
         LEFT JOIN comments p ON p.id = c.parent_id
         LEFT JOIN users pu ON pu.id = p.user_id
         LEFT JOIN users u ON u.id = c.user_id
         WHERE a.slug = ?
         ORDER BY c.created_at ASC LIMIT 300`,
        viewerId ? [viewerId, slug] : [slug]
      );
      if (Array.isArray(rows)) {
        return (rows as Record<string, unknown>[]).map((r) => ({
          id: Number(r.id),
          nickname: String(r.nickname),
          content: String(r.content),
          createdAt: String(r.createdAt),
          parentId: r.parentId ? Number(r.parentId) : null,
          parentAuthor: r.parentAuthor ? String(r.parentAuthor) : null,
          likes: Number(r.likes ?? 0),
          viewerLiked: Boolean(Number(r.viewerLiked ?? 0)),
          userId: r.userId ? Number(r.userId) : null,
          avatarText: String(r.avatarText ?? ""),
          avatarTone: String(r.avatarTone ?? ""),
          avatarShape: String(r.avatarShape ?? ""),
        }));
      }
    } catch {
      // 降级
    }
  }
  return demoToCommentRows(slug);
}

export async function searchArticles(
  q: string,
  limit = 20,
  viewerId?: number | null
): Promise<SearchResultRow[]> {
  const kw = q.trim().slice(0, 60);
  if (kw.length < 2) return [];
  const pool = await getPool();
  if (!pool) return [];
  // v17.0：转义 LIKE 通配符（% _ \），防用户关键词里的 % 变成全匹配
  const like = `%${kw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  // v17.2 付费墙纵深（严重级修复）：付费文「未解锁」时，正文既不得被检索、也不得回传摘录。
  // 修复前的 hit 字段取自完整 md_content，匿名访客用 /api/search?q=<付费正文里的词> 就能
  // 拿到围绕该词的 120 字付费原文；且 md_content LIKE 本身是一个可无限次探测
  // 「正文里有没有这个词」的 oracle，逐词二分即可拖走整篇付费内容。
  // viewerId 缺省（0）= 游客：付费文一律只按标题/摘要命中。
  const me = Number(viewerId) > 0 ? Number(viewerId) : 0;
  const locked = `(IFNULL(a.unlock_price,0) > 0 AND a.author_id <> ?
        AND NOT EXISTS (SELECT 1 FROM article_purchases p
                         WHERE p.article_id = a.id AND p.user_id = ?))`;
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, a.summary, u.nickname AS author, a.author_id AS authorId, a.tags,
              a.read_count AS readCount, a.like_count AS likeCount, a.comment_count AS commentCount,
              DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
              IFNULL(a.unlock_price,0) AS unlockPrice,
              IFNULL(a.discount_price,0) AS discountPrice,
              a.discount_until AS discountUntil,
              IF(${locked}, NULL,
                 (SELECT SUBSTRING(a.md_content,
                    GREATEST(1, LOCATE(?, a.md_content) - 40),
                    120))) AS hit
       FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
         AND (a.title LIKE ? OR a.summary LIKE ?
              OR (NOT ${locked} AND a.md_content LIKE ?))
       /* 相关度：标题命中 > 摘要命中 > 正文命中，同级按阅读量 */
       ORDER BY (a.title LIKE ?) DESC, (a.summary LIKE ?) DESC, a.read_count DESC
       LIMIT ?`,
      [me, me, kw, like, like, me, me, like, like, like, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      summary: String(r.summary ?? ""),
      author: String(r.author),
      authorId: r.authorId ? Number(r.authorId) : undefined,
      readCount: Number(r.readCount ?? 0),
      likeCount: Number(r.likeCount ?? 0),
      commentCount: Number(r.commentCount ?? 0),
      publishedAt: String(r.publishedAt ?? ""),
      hit: r.hit ? String(r.hit) : null,
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      unlockPrice: Number(r.unlockPrice ?? 0),
      discountPrice: Number(r.discountPrice ?? 0),
      discountUntil: r.discountUntil ? new Date(r.discountUntil as string).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

export async function followStats(userId: number): Promise<FollowStats> {
  const pool = await getPool();
  if (!pool) return { followers: 0, following: 0 };
  try {
    const [rows] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE followee_id = ?) AS followers,
         (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following`,
      [userId, userId]
    );
    const r = (rows as Record<string, unknown>[])[0] ?? {};
    return { followers: Number(r.followers ?? 0), following: Number(r.following ?? 0) };
  } catch {
    return { followers: 0, following: 0 };
  }
}

export async function isFollowing(followerId: number | null, followeeId: number): Promise<boolean> {
  if (!followerId) return false;
  const pool = await getPool();
  if (!pool) return false;
  try {
    const [rows] = await pool.query(
      `SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ? LIMIT 1`,
      [followerId, followeeId]
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

export async function listMyFollowers(userId: number, limit = 50): Promise<FollowPeer[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.nickname, u.avatar_text AS avatarText,
              COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
              IFNULL(u.bio, '') AS bio,
              (SELECT COUNT(*) FROM articles a
                WHERE a.author_id = u.id AND a.status = 'published' AND a.review_status = 'approved') AS articles
       FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = ?
       ORDER BY f.created_at DESC LIMIT ?`,
      [userId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      nickname: String(r.nickname),
      avatarText: String(r.avatarText ?? "墨"),
      avatarTone: String(r.avatarTone ?? ""),
      avatarShape: String(r.avatarShape ?? ""),
      bio: String(r.bio ?? ""),
      articles: Number(r.articles ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function listMyFollowing(userId: number, limit = 50): Promise<FollowPeer[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.nickname, u.avatar_text AS avatarText,
              COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
              IFNULL(u.bio, '') AS bio,
              (SELECT COUNT(*) FROM articles a
                WHERE a.author_id = u.id AND a.status = 'published' AND a.review_status = 'approved') AS articles
       FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = ?
       ORDER BY f.created_at DESC LIMIT ?`,
      [userId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      nickname: String(r.nickname),
      avatarText: String(r.avatarText ?? "墨"),
      avatarTone: String(r.avatarTone ?? ""),
      avatarShape: String(r.avatarShape ?? ""),
      bio: String(r.bio ?? ""),
      articles: Number(r.articles ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function listMyLikes(userId: number, limit = 30): Promise<FootprintArticle[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, u.nickname AS author, a.read_count AS readCount
       FROM article_likes l
       JOIN articles a ON a.id = l.article_id
       JOIN users u ON u.id = a.author_id
       WHERE l.user_id = ? AND a.status = 'published'
       ORDER BY l.created_at DESC LIMIT ?`,
      [userId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      author: String(r.author),
      readCount: Number(r.readCount ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function listMyComments(userId: number, limit = 30): Promise<MyCommentRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.content,
              DATE_FORMAT(c.created_at,'%Y-%m-%d') AS createdAt,
              a.slug AS articleSlug, a.title AS articleTitle
       FROM comments c JOIN articles a ON a.id = c.article_id
       WHERE c.user_id = ? AND a.status = 'published'
       ORDER BY c.created_at DESC LIMIT ?`,
      [userId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      content: String(r.content),
      createdAt: String(r.createdAt ?? ""),
      articleSlug: String(r.articleSlug),
       articleTitle: String(r.articleTitle),
    }));
  } catch {
    return [];
  }
}

export async function isBookmarked(userId: number | null, slug: string): Promise<boolean> {
  if (!userId) return false;
  const pool = await getPool();
  if (!pool) return false;
  try {
    const [rows] = await pool.query(
      `SELECT b.id FROM bookmarks b JOIN articles a ON a.id = b.article_id
       WHERE b.user_id = ? AND a.slug = ? LIMIT 1`,
      [userId, slug]
    );
    return Array.isArray(rows) && (rows as unknown[]).length > 0;
  } catch {
    return false;
  }
}

export async function listMyBookmarks(userId: number, limit = 50): Promise<BookmarkRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, u.nickname AS author, a.read_count AS readCount,
              DATE_FORMAT(b.created_at,'%Y-%m-%d') AS savedAt
       FROM bookmarks b
       JOIN articles a ON a.id = b.article_id
       JOIN users u ON u.id = a.author_id
       WHERE b.user_id = ? AND a.status = 'published'
       ORDER BY b.created_at DESC LIMIT ?`,
      [userId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      author: String(r.author),
      readCount: Number(r.readCount ?? 0),
      savedAt: String(r.savedAt ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function listMyHistory(userId: number, limit = 30): Promise<HistoryRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, u.nickname AS author, a.read_count AS readCount,
              DATE_FORMAT(h.read_at,'%Y-%m-%d %H:%i') AS readAt, h.read_times AS times
       FROM read_history h
       JOIN articles a ON a.id = h.article_id
       JOIN users u ON u.id = a.author_id
       WHERE h.user_id = ? AND a.status = 'published'
       ORDER BY h.read_at DESC LIMIT ?`,
      [userId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      author: String(r.author),
      readCount: Number(r.readCount ?? 0),
      readAt: String(r.readAt ?? ""),
      times: Number(r.times ?? 1),
    }));
  } catch {
    return [];
  }
}

export async function authorArticleStats(authorId: number, limit = 50): Promise<AuthorArticleStat[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, a.status, DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
              a.read_count AS readCount, a.like_count AS likeCount, a.comment_count AS commentCount,
              IFNULL((SELECT SUM(t.amount) FROM article_tips t WHERE t.article_id = a.id), 0) AS tipTotal,
              (SELECT MAX(b.boost_until) FROM article_boosts b
                WHERE b.article_id = a.id AND b.boost_until > NOW()) AS boostUntil
       FROM articles a
       WHERE a.author_id = ? AND a.status <> 'deleted'
       ORDER BY GREATEST(a.read_count, 1) DESC, a.id DESC LIMIT ?`,
      [authorId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      status: String(r.status ?? "published"),
      publishedAt: String(r.publishedAt ?? ""),
      readCount: Number(r.readCount ?? 0),
      likeCount: Number(r.likeCount ?? 0),
      commentCount: Number(r.commentCount ?? 0),
      tipTotal: Number(r.tipTotal ?? 0),
      boostUntil: r.boostUntil ? String(r.boostUntil) : null,
    }));
  } catch {
    return [];
  }
}

export async function getAuthor(id: number): Promise<AuthorProfile | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const pool = await getPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.nickname, u.avatar_text AS avatarText,
              COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
              IFNULL(u.bio,'') AS bio,
              DATE_FORMAT(u.created_at,'%Y-%m-%d') AS createdAt,
              (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id
                AND a.status='published' AND a.review_status='approved') AS articles,
              (SELECT IFNULL(SUM(a.like_count),0) FROM articles a WHERE a.author_id = u.id
                AND a.status='published' AND a.review_status='approved') AS likes,
              (SELECT IFNULL(SUM(a.read_count),0) FROM articles a WHERE a.author_id = u.id
                AND a.status='published' AND a.review_status='approved') AS readTotal
       FROM users u WHERE u.id = ? LIMIT 1`,
      [id]
    );
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      nickname: String(r.nickname),
      avatarText: String(r.avatarText ?? "墨"),
      avatarTone: String(r.avatarTone ?? ""),
      avatarShape: String(r.avatarShape ?? ""),
      bio: String(r.bio ?? ""),
      createdAt: String(r.createdAt ?? ""),
      articles: Number(r.articles ?? 0),
      likes: Number(r.likes ?? 0),
      readTotal: Number(r.readTotal ?? 0),
    };
  } catch {
    return null;
  }
}

export async function listAuthorArticles(authorId: number, limit = 30): Promise<ArticleRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, u.nickname AS author, u.avatar_text AS authorAvatar,
              a.summary, IFNULL(a.cover_label,'') AS coverLabel, a.tags,
              a.read_count AS readCount, a.comment_count AS commentCount,
              a.agent_qa_count AS agentQaCount, a.like_count AS likeCount,
              DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
              (SELECT IFNULL(SUM(t.amount),0) FROM article_tips t WHERE t.article_id = a.id) AS tipTotal,
              IFNULL(a.unlock_price,0) AS unlockPrice,
              IFNULL(a.discount_price,0) AS discountPrice,
              a.discount_until AS discountUntil
       FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.author_id = ? AND a.status = 'published' AND a.review_status = 'approved'
       ORDER BY a.published_at DESC LIMIT ?`,
      [authorId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      author: String(r.author),
      authorAvatar: String(r.authorAvatar),
      summary: String(r.summary ?? ""),
      coverLabel: String(r.coverLabel ?? ""),
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      readCount: Number(r.readCount),
      commentCount: Number(r.commentCount),
      agentQaCount: Number(r.agentQaCount),
      publishedAt: dateOnly(r.publishedAt),
      md: "",
      likeCount: Number(r.likeCount ?? 0),
      tipTotal: Number(r.tipTotal ?? 0),
      unlockPrice: Number(r.unlockPrice ?? 0),
      discountPrice: Number(r.discountPrice ?? 0),
      discountUntil: r.discountUntil ? new Date(r.discountUntil as string).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

export async function listSeries(limit = 60, authorId?: number): Promise<SeriesCard[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const where = authorId ? `WHERE s.author_id = ?` : "";
    const [rows] = await pool.query(
      `SELECT s.id, s.title, s.description, s.updated_at AS updatedAt, s.bundle_price AS bundlePrice,
              u.nickname AS author, u.avatar_text AS authorAvatar, u.id AS authorId,
              COUNT(si.article_id) AS articleCount,
              COALESCE(SUM(a.read_count), 0) AS totalReads,
              (SELECT IFNULL(SUM(sp.item_count),0) FROM series_purchases sp WHERE sp.series_id = s.id) AS soldCount
         FROM series s
         JOIN users u ON u.id = s.author_id
         LEFT JOIN series_items si ON si.series_id = s.id
         LEFT JOIN articles a ON a.id = si.article_id
              AND a.status = 'published' AND a.review_status = 'approved'
         ${where}
        GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?`,
      authorId ? [authorId, limit] : [limit]
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      description: String(r.description ?? ""),
      author: String(r.author),
      authorAvatar: String(r.authorAvatar ?? "墨"),
      authorId: Number(r.authorId),
      articleCount: Number(r.articleCount),
      totalReads: Number(r.totalReads ?? 0),
      soldCount: Number(r.soldCount ?? 0),
      bundlePrice: Number(r.bundlePrice ?? 0),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString().slice(0, 10) : String(r.updatedAt ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function getSeriesDetail(id: number, viewer?: { id?: number | null }): Promise<SeriesDetail | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const [sRows] = await pool.query(
      `SELECT s.id, s.title, s.description, s.bundle_price AS bundlePrice,
              u.nickname AS author, u.avatar_text AS authorAvatar, u.id AS authorId
         FROM series s JOIN users u ON u.id = s.author_id WHERE s.id = ? LIMIT 1`,
      [id]
    );
    const s = (sRows as Record<string, unknown>[])[0];
    if (!s) return null;
    const viewerId = viewer?.id ?? null;
    const [iRows] = await pool.query(
      `SELECT a.slug, a.title, a.read_count AS readCount, a.published_at AS publishedAt,
              a.author_id AS authorId,
              IFNULL(a.unlock_price,0) AS unlockPrice,
              IFNULL(a.discount_price,0) AS discountPrice, a.discount_until AS discountUntil,
              ${viewerId ? `EXISTS(SELECT 1 FROM article_purchases p WHERE p.article_id = a.id AND p.user_id = ?)` : "FALSE"} AS viewerUnlocked
         FROM series_items si JOIN articles a ON a.id = si.article_id
        WHERE si.series_id = ? AND a.status = 'published' AND a.review_status = 'approved'
        ORDER BY si.position, si.article_id`,
      viewerId ? [viewerId, id] : [id]
    );
    const items = (iRows as Record<string, unknown>[]).map((r) => {
      const unlockPrice = Number(r.unlockPrice ?? 0);
      const effective = effectiveUnlockPrice({
        unlockPrice,
        discountPrice: Number(r.discountPrice ?? 0),
        discountUntil: r.discountUntil ? new Date(r.discountUntil as string).toISOString() : null,
      });
      const isOwn = viewerId !== null && Number(r.authorId) === viewerId;
      const lockedForViewer =
        unlockPrice > 0 && !isOwn && Number(r.viewerUnlocked ?? 0) !== 1;
      return {
        slug: String(r.slug),
        title: String(r.title),
        readCount: Number(r.readCount ?? 0),
        publishedAt: r.publishedAt instanceof Date ? r.publishedAt.toISOString().slice(0, 10) : "",
        unlockPrice: effective,
        lockedForViewer,
      };
    });
    const [bRows] = await pool.query(
      `SELECT 1 AS ok FROM series_purchases WHERE series_id = ? AND user_id = ? LIMIT 1`,
      [id, viewerId ?? 0]
    );
    const [cRows] = await pool.query(
      `SELECT COUNT(*) AS c, IFNULL(SUM(item_count),0) AS unlocked FROM series_purchases WHERE series_id = ?`,
      [id]
    );
    const fullPrice = items.filter((x) => x.lockedForViewer).reduce((sum, x) => sum + x.unlockPrice, 0);
    return {
      id: Number(s.id),
      title: String(s.title),
      description: String(s.description ?? ""),
      author: String(s.author),
      authorAvatar: String(s.authorAvatar ?? "墨"),
      authorId: Number(s.authorId),
      items,
      bundlePrice: Number(s.bundlePrice ?? 0) > 0 ? Number(s.bundlePrice) : null,
      bundlePurchased: viewerId !== null && (bRows as unknown[]).length > 0,
      fullPrice,
      paidCount: items.filter((x) => x.unlockPrice > 0).length,
      soldCount: Number((cRows as Record<string, unknown>[])[0]?.unlocked ?? 0),
    };
  } catch {
    return null;
  }
}

export async function listMySeries(authorId: number): Promise<MySeries[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [sRows] = await pool.query(
      `SELECT id, title, description FROM series WHERE author_id = ? ORDER BY updated_at DESC`,
      [authorId]
    );
    const series = (sRows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      description: String(r.description ?? ""),
      items: [] as { slug: string; title: string }[],
    }));
    if (series.length === 0) return [];
    const [iRows] = await pool.query(
      `SELECT si.series_id AS seriesId, a.slug, a.title
         FROM series_items si JOIN articles a ON a.id = si.article_id
        WHERE si.series_id IN (${series.map(() => "?").join(",")})
        ORDER BY si.position, si.article_id`,
      series.map((s) => s.id)
    );
    for (const r of iRows as Record<string, unknown>[]) {
      const target = series.find((s) => s.id === Number(r.seriesId));
      if (target) target.items.push({ slug: String(r.slug), title: String(r.title) });
    }
    return series;
  } catch {
    return [];
  }
}

export async function getArticleSeriesNav(slug: string): Promise<ArticleSeriesNav | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.query(
      `SELECT si.series_id AS seriesId, si.position, s.title
         FROM articles a
         JOIN series_items si ON si.article_id = a.id
         JOIN series s ON s.id = si.series_id
        WHERE a.slug = ? ORDER BY si.position LIMIT 1`,
      [slug]
    );
    const cur = (rows as Record<string, unknown>[])[0];
    if (!cur) return null;
    const seriesId = Number(cur.seriesId);
    const [all] = await pool.query(
      `SELECT si.article_id AS articleId, si.position, a.slug, a.title
         FROM series_items si JOIN articles a ON a.id = si.article_id
        WHERE si.series_id = ? AND a.status = 'published' AND a.review_status = 'approved'
        ORDER BY si.position, si.article_id`,
      [seriesId]
    );
    const items = all as Record<string, unknown>[];
    const [self] = await pool.query(`SELECT id FROM articles WHERE slug = ? LIMIT 1`, [slug]);
    const selfId = (self as Record<string, unknown>[])[0];
    if (!selfId) return null;
    const idx = items.findIndex((r) => Number(r.articleId) === Number(selfId.id));
    if (idx === -1) return null;
    const near = (r: Record<string, unknown> | undefined) =>
      r ? { slug: String(r.slug), title: String(r.title) } : null;
    return {
      id: seriesId,
      title: String(cur.title),
      position: idx + 1,
      total: items.length,
      prev: idx > 0 ? near(items[idx - 1]) : null,
      next: idx < items.length - 1 ? near(items[idx + 1]) : null,
    };
  } catch {
    return null;
  }
}

export async function listMyFunnel(authorId: number): Promise<FunnelRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, a.read_count AS views, IFNULL(a.paywall_views,0) AS paywallViews,
              (SELECT COUNT(*) FROM article_purchases ap WHERE ap.article_id = a.id) AS unlocks,
              (SELECT IFNULL(SUM(ap.author_gain),0) FROM article_purchases ap WHERE ap.article_id = a.id) AS revenue
         FROM articles a
        WHERE a.author_id = ? AND a.status <> 'deleted' AND IFNULL(a.unlock_price,0) > 0
        ORDER BY unlocks DESC, a.read_count DESC LIMIT 30`,
      [authorId]
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      views: Number(r.views ?? 0),
      paywallViews: Number(r.paywallViews ?? 0),
      unlocks: Number(r.unlocks ?? 0),
      revenue: Number(r.revenue ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function listMyUnlockIncome(authorId: number): Promise<UnlockIncome> {
  const empty: UnlockIncome = { total: 0, sales: 0, byArticle: [] };
  const pool = await getPool();
  if (!pool || !authorId) return empty;
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, IFNULL(a.unlock_price,0) AS price,
              COUNT(p.id) AS sales, IFNULL(SUM(p.author_gain),0) AS earned
         FROM article_purchases p
         JOIN articles a ON a.id = p.article_id
        WHERE a.author_id = ?
        GROUP BY a.id, a.slug, a.title
        ORDER BY earned DESC, sales DESC
        LIMIT 20`,
      [authorId]
    );
    if (!Array.isArray(rows) || rows.length === 0) return empty;
    const byArticle = (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      price: Number(r.price ?? 0),
      sales: Number(r.sales ?? 0),
      earned: Number(r.earned ?? 0),
    }));
    return {
      total: byArticle.reduce((s, x) => s + x.earned, 0),
      sales: byArticle.reduce((s, x) => s + x.sales, 0),
      byArticle,
    };
  } catch {
    return empty;
  }
}

/* ---------- 每周墨报：JS 组装 + SQL 计数 ----------
 * 页面侧的同名函数（lib/data.ts）只剩组装与"本期计数交给 Java"；这里保留"没有 Java 时
 * Node 自己数"的完整实现。组装取的 listArticles / listSeries / rankHot 全在本文件这一侧，
 * 否则会串到 data.ts 的 Java 路上去——那样这份实现就不再独立了。
 */
export async function listWeekly(): Promise<WeeklyReport> {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 3.6e6);
  const fromStr = weeklyFmt(from);
  const toStr = weeklyFmt(now);
  // 期号：自 2026-06-29 起的周数
  const issue = Math.max(
    1,
    Math.floor((now.getTime() - new Date("2026-06-29T00:00:00+08:00").getTime()) / (7 * 24 * 3.6e6)) + 1
  );
  const top = rankHot(await listArticles(), "week", 5);
  const all = await listArticles();
  const published = all.filter((a) => a.reviewStatus === undefined || a.reviewStatus === "approved");
  const latest = [...published]
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
    .filter((a) => a.publishedAt >= fromStr)
    .slice(0, 8);
  const series = await listSeries(3);
  const weeks: { label: string; count: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const end = now.getTime() - i * 7 * 24 * 3.6e6;
    const endD = new Date(end);
    weeks.push({
      label: String(endD.getMonth() + 1).padStart(2, "0") + "/" + String(endD.getDate()).padStart(2, "0"),
      count: published.filter((a) => {
        const t = new Date(a.publishedAt + "T08:00:00+08:00").getTime();
        return t > end - 7 * 24 * 3.6e6 && t <= end;
      }).length,
    });
  }
  const base: WeeklyReport = {
    from: fromStr, to: toStr, issue,
    newArticles: 0, newUsers: 0, newComments: 0,
    tipCount: 0, tipInk: 0, newSeries: 0,
    top, latest, series, weeks,
  };
  const pool = await getPool();
  if (!pool) return base;
  try {
    const cnt = async (sql: string, args: unknown[] = []): Promise<number> => {
      const [r] = await pool.query(sql, args);
      return Number((r as Record<string, unknown>[])[0]?.c ?? 0);
    };
    const pubFilter = "status='published' AND (review_status IS NULL OR review_status='approved')";
    const [newArticles, newUsers, newComments, newSeries, tipRow] = await Promise.all([
      cnt("SELECT COUNT(*) AS c FROM articles WHERE " + pubFilter + " AND published_at >= ?", [fromStr]),
      cnt("SELECT COUNT(*) AS c FROM users WHERE created_at >= ?", [fromStr]),
      cnt("SELECT COUNT(*) AS c FROM comments WHERE created_at >= ?", [fromStr]),
      cnt("SELECT COUNT(*) AS c FROM series WHERE created_at >= ?", [fromStr]),
      (async () => {
        const [r] = await pool.query(
          "SELECT COUNT(*) AS c, IFNULL(SUM(amount),0) AS s FROM article_tips WHERE created_at >= ?",
          [fromStr]
        );
        const row = (r as Record<string, unknown>[])[0] ?? {};
        return { c: Number(row.c ?? 0), s: Number(row.s ?? 0) };
      })(),
    ]);
    return { ...base, newArticles, newUsers, newComments, newSeries, tipCount: tipRow.c, tipInk: tipRow.s };
  } catch {
    return base;
  }
}
