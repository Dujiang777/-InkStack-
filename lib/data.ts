// 统一数据访问层：优先读 MySQL，连接失败或未配置时自动降级为演示数据
// 这样个人开发者可以先把界面跑起来，再接数据库
import { getPool } from "./db";
import { demoArticles, demoComments, type DemoArticle, type DemoComment } from "./demo-data";

/* ---------- 数据库可重试错误（v18.0） ----------
 * InnoDB 的死锁与锁等待超时属于**可重试**错误：官方建议由应用侧重放整个语句/事务。
 * 用于「多条无锁语句构成一次逻辑写」的场景（如 toggleBookmark 的 INSERT IGNORE→DELETE）。
 * 判定只看错误码，不做字符串匹配。
 */
const RETRYABLE_LOCK_ERRORS = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

function isRetryableLockError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && RETRYABLE_LOCK_ERRORS.has(code);
}

/** 退避等待（带抖动由调用方给值，避免并发重试同步对撞） */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ArticleRow = {
  slug: string;
  title: string;
  author: string;
  authorAvatar: string;
  summary: string;
  coverLabel: string;
  tags: string[];
  readCount: number;
  commentCount: number;
  agentQaCount: number;
  publishedAt: string;
  md: string;
  authorId?: number;
  /** 加热中截止时间（未加热为 null）；过期自动视为未加热 */
  boostUntil?: string | null;
  /** 累计收到打赏点墨 */
  tipTotal?: number;
  /** 累计点赞数 */
  likeCount?: number;
  /** 审核状态（仅作者/管理员可见非 approved 文章时返回） */
  reviewStatus?: "pending" | "approved" | "rejected";
  /** 驳回原因（rejected 时有值） */
  reviewNote?: string | null;
  /** 当前浏览者是否已点赞 */
  viewerLiked?: boolean;
  /** 付费解锁定价（0 = 免费）；仅详情查询返回 */
  unlockPrice?: number;
  /** 早鸟价：折扣价与截止时间（过期/无效即回落原价） */
  discountPrice?: number;
  discountUntil?: string | null;
  /** 累计解锁人次（仅详情查询返回，>0 时付费卡显示热度） */
  unlockCount?: number;
  /** 当前浏览者是否已可读全文（作者/管理员/已购买） */
  viewerUnlocked?: boolean;
  /** 印章工坊（v17.4）：作者印面（详情查询返回） */
  authorTone?: string;
  authorShape?: string;
};

/** 日期归一化：DB 的 DATE_FORMAT 结果 → 'YYYY-MM-DD'；NULL/非法值一律返回空串。
 *  v17.1 修复：老库存在 published_at 为 NULL 的已发布文章（迁移导入时源站无日期），
 *  原先 String(null) 会得到字符串 "null"，下游 new Date("null").toISOString() 直接抛
 *  RangeError: Invalid time value —— /sitemap.xml 曾因此整站 500。 */
function dateOnly(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

/** 早鸟价统一计价：折扣有效（0 < 折扣 < 原价 且未到期）取折扣，否则原价 */
export function effectiveUnlockPrice(a: { unlockPrice?: number; discountPrice?: number; discountUntil?: string | null }): number {
  const original = a.unlockPrice ?? 0;
  const d = a.discountPrice ?? 0;
  if (original <= 0 || d <= 0 || d >= original) return original;
  if (a.discountUntil && new Date(a.discountUntil).getTime() <= Date.now()) return original;
  return d;
}

/* ---------- 印章头像列（v17.4 印章工坊）：懒迁移，进程内只查一次 ---------- */
let avatarColsReady: Promise<boolean> | null = null;
export function ensureAvatarColumns(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>): Promise<boolean> {
  if (!avatarColsReady) {
    avatarColsReady = (async () => {
      try {
        const [cols] = await pool.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
              AND COLUMN_NAME IN ('avatar_tone','avatar_shape')`
        );
        const have = new Set((cols as { COLUMN_NAME: string }[]).map((r) => r.COLUMN_NAME));
        if (!have.has("avatar_tone")) {
          await pool.query(`ALTER TABLE users ADD COLUMN avatar_tone VARCHAR(16) NOT NULL DEFAULT ''`);
        }
        if (!have.has("avatar_shape")) {
          await pool.query(`ALTER TABLE users ADD COLUMN avatar_shape VARCHAR(16) NOT NULL DEFAULT ''`);
        }
        return true;
      } catch {
        // 列缺失时读取面会拿到 undefined → 走随缘派色兜底，不阻塞主流程
        return false;
      }
    })();
  }
  return avatarColsReady;
}

/** 早鸟价入参校验：返回可落库的 [discountPrice, discountUntil]（无效一律回落 [null, null]） */
export function parseDiscount(
  discountPrice: unknown,
  discountUntil: unknown,
  unlockPrice: number
): [number | null, string | null] {
  const d = Math.floor(Number(discountPrice) || 0);
  if (unlockPrice <= 0 || d <= 0 || d >= unlockPrice) return [null, null];
  const t = discountUntil ? new Date(String(discountUntil)) : null;
  if (!t || isNaN(t.getTime())) return [null, null];
  const max = Date.now() + 30 * 24 * 3.6e6;
  const ts = t.getTime();
  if (ts <= Date.now() || ts > max) return [null, null];
  return [d, t.toISOString().slice(0, 19).replace("T", " ")];
}

function demoToRow(a: DemoArticle): ArticleRow {
  return { ...a };
}

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

/* ---------- 标签聚合页：/tag/[tag] ---------- */

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

// 演示模式下的重力排序（与 DB SQL 同一公式）
function gravity(a: { readCount: number; commentCount: number; agentQaCount: number; publishedAt: string }): number {
  const hours = Math.max(0, (Date.now() - new Date(a.publishedAt + "T08:00:00+08:00").getTime()) / 3.6e6);
  return (
    Math.log10(a.readCount + a.commentCount * 5 + a.agentQaCount * 10 + 10) /
    Math.pow(hours + 2, 1.2)
  );
}

/** 取单篇文章。
 * 可见性：approved 公开；pending/rejected 仅作者本人或管理员可见。
 * viewer 传入当前浏览者（id + 是否管理员），用于可见性判断与点赞状态。 */
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
      await ensurePaidColumns(pool);
      await ensureAvatarColumns(pool);
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

/* ---------- 相关阅读：同标签 > 同作者 > 其余（重力序兜底） ---------- */

export async function listRelated(
  slug: string,
  authorId?: number,
  tags: string[] = [],
  limit = 3
): Promise<ArticleRow[]> {
  const all = (await listArticles()).filter((a) => a.slug !== slug);
  const tagSet = new Set(tags);
  const score = (a: ArticleRow) =>
    (authorId && a.authorId === authorId ? 2 : 0) +
    a.tags.reduce((n, t) => n + (tagSet.has(t) ? 1 : 0), 0);
  // listArticles 已按重力排序，稳定排序保证同分时热度优先
  return [...all].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/* ---------- 最新墨水：本文最近打赏动态 ---------- */

export type ArticleTipRow = {
  fromName: string;
  fromAvatar: string;
  amount: number;
  createdAt: string;
};

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

/* ============ 我的书房：个人文章管理 ============ */

export type MyArticleRow = {
  slug: string;
  title: string;
  status: string;
  reviewStatus: string;
  reviewNote: string | null;
  readCount: number;
  likeCount: number;
  commentCount: number;
  agentQaCount: number;
  tipTotal: number;
  boostUntil: string | null;
  updatedAt: string;
};

export type MyStats = {
  published: number;
  totalReads: number;
  totalLikes: number;
  tipIncome: number;
  totalQa: number;
  drafts: number;
};

/** 书房：我的全部文章（含待审/驳回/下架）+ 汇总数据 */
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

/* ============ 评论区 ============ */

export type CommentRow = {
  id: number;
  nickname: string;
  content: string;
  createdAt: string;
  /** 回复的目标评论 id（顶层评论为 null） */
  parentId?: number | null;
  /** 被回复人的昵称（用于「回复 @xx」展示） */
  parentAuthor?: string | null;
  /** 评论获赞数 */
  likes: number;
  /** 当前浏览者是否已赞该评论 */
  viewerLiked: boolean;
  /** 印章工坊（v17.4）：评论者 id 与印面（游客评论无 id，走经典墨） */
  userId?: number | null;
  avatarText?: string;
  avatarTone?: string;
  avatarShape?: string;
};

function demoToCommentRows(slug: string): CommentRow[] {
  return (demoComments[slug] ?? []).map((c) => ({ ...c, likes: 0, viewerLiked: false }));
}

/* ---------- 评论点赞（comment_likes 懒建表） ---------- */

const gCL = globalThis as unknown as { __inkClReady?: boolean };

async function ensureCommentLikesTable(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>): Promise<void> {
  if (gCL.__inkClReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS comment_likes (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    comment_id BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_cl (comment_id, user_id),
    INDEX idx_cl_comment (comment_id),
    CONSTRAINT fk_cl_comment FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    CONSTRAINT fk_cl_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  gCL.__inkClReady = true;
}

/** 评论点赞/取消（toggle），返回最新状态 */
export async function toggleCommentLike(userId: number, commentId: number): Promise<{ liked: boolean; likes: number }> {
  const pool = await getPool();
  if (!pool) return { liked: false, likes: 0 };
  await ensureCommentLikesTable(pool);
  const [exist] = await pool.query(`SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ? LIMIT 1`, [
    commentId,
    userId,
  ]);
  const has = Array.isArray(exist) && (exist as unknown[]).length > 0;
  if (has) {
    await pool.query(`DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?`, [commentId, userId]);
  } else {
    await pool.query(`INSERT IGNORE INTO comment_likes (comment_id, user_id) VALUES (?, ?)`, [commentId, userId]);
  }
  const [cnt] = await pool.query(`SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?`, [commentId]);
  const likes = Array.isArray(cnt) ? Number((cnt as Record<string, unknown>[])[0]?.n ?? 0) : 0;
  return { liked: !has, likes };
}

export async function listComments(slug: string, viewerId?: number | null): Promise<CommentRow[]> {
  const pool = await getPool();
  if (pool) {
    try {
      await ensureCommentLikesTable(pool);
      await ensureAvatarColumns(pool);
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

export async function addComment(
  slug: string,
  input: { nickname: string; content: string; parentId?: number | null },
  user?: { id: number; nickname: string } // 传入则绑定账号，昵称以账号为准
): Promise<{ ok: boolean; error?: string; id?: number; createdAt?: string }> {
  const nickname = (user?.nickname ?? input.nickname).trim().slice(0, 20) || "访客";
  const content = input.content.trim();
  if (!content) return { ok: false, error: "评论内容不能为空" };
  if (content.length > 1000) return { ok: false, error: "评论最长 1000 字" };

  const pool = await getPool();
  if (pool) {
    try {
      // 回复目标校验：必须存在且属于同一篇文章（防跨文串楼）
      let parentId: number | null = null;
      if (input.parentId) {
        const [pRows] = await pool.query(
          `SELECT c.id FROM comments c JOIN articles a ON a.id = c.article_id
           WHERE c.id = ? AND a.slug = ? LIMIT 1`,
          [input.parentId, slug]
        );
        parentId = (pRows as { id: number }[])[0]?.id ?? null;
        if (!parentId) return { ok: false, error: "要回复的评论不存在或已删除" };
      }
      // v17.5：INSERT..SELECT 补 status='published'。原实现不限定状态，任何人只要猜到
      //   slug（中文标题的草稿 slug 形如 bo-20260918-1，可枚举）就能给别人的**草稿/已撤回**
      //   文章灌评论——既污染未公开内容，又给作者发通知，还种下 comments 外键子行
      //   导致作者草稿硬删被 FK 挡下。同时不再对未命中的 slug 虚增 comment_count。
      const [ins] = await pool.query(
        `INSERT INTO comments (article_id, user_id, guest_nickname, parent_id, content)
         SELECT id, ?, ?, ?, ? FROM articles WHERE slug = ? AND status = 'published'`,
        [user?.id ?? null, user ? null : nickname, parentId, content, slug]
      );
      if (Number((ins as { affectedRows?: number }).affectedRows ?? 0) === 0) {
        return { ok: false, error: "文章不存在或未公开，无法评论" };
      }
      await pool.query(
        `UPDATE articles SET comment_count = comment_count + 1 WHERE slug = ?`,
        [slug]
      );
      // 返回真实 id 与服务端时间，前端用它替换占位行（否则新评论立刻点赞/回复会 404）
      const newId = Number((ins as { insertId?: number }).insertId ?? 0) || undefined;
      const [t] = await pool.query(`SELECT DATE_FORMAT(NOW(),'%Y-%m-%d %H:%i') AS createdAt`);
      return { ok: true, id: newId, createdAt: (t as { createdAt: string }[])[0]?.createdAt };
    } catch {
      return { ok: false, error: "数据库暂不可用，评论未保存" };
    }
  }
  // 演示模式：只回成功但不持久化（页面刷新后消失，属预期行为）
  return { ok: true, error: undefined };
}

/* ============ 运营台：内容管理 ============ */

export type AdminArticleRow = {
  slug: string;
  title: string;
  author: string;
  status: string;
  reviewStatus: string;
  pinned: boolean;
  featured: boolean;
  readCount: number;
  commentCount: number;
  publishedAt: string;
  unlockPrice: number;
};

export async function adminListArticles(): Promise<AdminArticleRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT a.slug, a.title, u.nickname AS author, a.status, a.review_status AS reviewStatus,
            a.pinned, a.featured,
            a.read_count AS readCount, a.comment_count AS commentCount,
            IFNULL(a.unlock_price,0) AS unlockPrice,
            DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt
     FROM articles a JOIN users u ON u.id = a.author_id
     ORDER BY a.updated_at DESC LIMIT 100`
  );
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[]).map((r) => ({
    slug: String(r.slug),
    title: String(r.title),
    author: String(r.author),
    status: String(r.status),
    reviewStatus: String(r.reviewStatus ?? "approved"),
    pinned: Number(r.pinned) === 1,
    featured: Number(r.featured) === 1,
    readCount: Number(r.readCount),
    commentCount: Number(r.commentCount),
    publishedAt: String(r.publishedAt ?? "—"),
    unlockPrice: Number(r.unlockPrice ?? 0),
  }));
}

export type AdminAction = "publish" | "unpublish" | "pin" | "unpin" | "feature" | "unfeature";

const ACTION_SQL: Record<AdminAction, string> = {
  publish: "status = 'published'",
  unpublish: "status = 'removed'",
  pin: "pinned = 1 - pinned",
  unpin: "pinned = 0",
  feature: "featured = 1 - featured",
  unfeature: "featured = 0",
};

/** 运营操作：下架/发布/置顶/精选。返回是否生效 */
export async function adminSetArticle(slug: string, action: AdminAction): Promise<{ ok: boolean; error?: string }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库不可用" };
  const sql = ACTION_SQL[action];
  if (!sql) return { ok: false, error: "未知操作" };
  // 下架时同时取消置顶/精选，避免僵尸状态
  const extra = action === "unpublish" ? ", pinned = 0, featured = 0" : "";
  const [res] = await pool.query(`UPDATE articles SET ${sql}${extra} WHERE slug = ?`, [slug]);
  const affected = (res as { affectedRows?: number }).affectedRows ?? 0;
  return affected > 0 ? { ok: true } : { ok: false, error: "文章不存在" };
}

/* ============ 管理后台：审核 / 用户 / 举报 / 审计日志 ============ */

export type ReviewRow = {
  slug: string;
  title: string;
  author: string;
  summary: string;
  submittedAt: string;
};

/** 审核队列：待审核文章（最早提交优先） */
export async function adminListReview(): Promise<ReviewRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT a.slug, a.title, u.nickname AS author, a.summary,
            DATE_FORMAT(a.updated_at,'%m-%d %H:%i') AS submittedAt
     FROM articles a JOIN users u ON u.id = a.author_id
     WHERE a.review_status = 'pending' AND a.status = 'published'
     ORDER BY a.updated_at ASC LIMIT 50`
  );
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[]).map((r) => ({
    slug: String(r.slug),
    title: String(r.title),
    author: String(r.author),
    summary: String(r.summary ?? ""),
    submittedAt: String(r.submittedAt ?? "—"),
  }));
}

export type AdminUserRow = {
  id: number;
  nickname: string;
  email: string;
  role: string;
  banned: boolean;
  points: number;
  articleCount: number;
  createdAt: string;
};

/** 用户管理列表（q 模糊匹配昵称/邮箱） */
export async function adminListUsers(q?: string): Promise<AdminUserRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  const like = `%${(q ?? "").trim()}%`;
  const [rows] = await pool.query(
    `SELECT u.id, u.nickname, u.email, u.role, u.banned, u.points_balance AS points,
            (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id) AS articleCount,
            DATE_FORMAT(u.created_at,'%Y-%m-%d') AS createdAt
     FROM users u
     WHERE ? = '%%' OR u.nickname LIKE ? OR u.email LIKE ?
     ORDER BY u.id ASC LIMIT 200`,
    [like, like, like]
  );
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    nickname: String(r.nickname),
    email: String(r.email),
    role: String(r.role),
    banned: Number(r.banned) === 1,
    points: Number(r.points),
    articleCount: Number(r.articleCount),
    createdAt: String(r.createdAt ?? "—"),
  }));
}

export type ReportRow = {
  id: number;
  targetType: "article" | "comment";
  targetId: number;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  reporter: string;
  targetTitle: string;
  createdAt: string;
};

/** 举报处理队列（status 缺省返回全部） */
export async function adminListReports(status?: string): Promise<ReportRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.status,
            COALESCE(ru.nickname, '游客') AS reporter,
            CASE r.target_type
              WHEN 'article' THEN (SELECT a.title FROM articles a WHERE a.id = r.target_id)
              ELSE (SELECT CONCAT('评论：', LEFT(c.content, 40))
                    FROM comments c WHERE c.id = r.target_id)
            END AS targetTitle,
            DATE_FORMAT(r.created_at,'%m-%d %H:%i') AS createdAt
     FROM reports r
     LEFT JOIN users ru ON ru.id = r.reporter_id
     ${status ? "WHERE r.status = ?" : ""}
     ORDER BY r.created_at DESC LIMIT 100`,
    status ? [status] : []
  );
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    targetType: String(r.targetType) as "article" | "comment",
    targetId: Number(r.targetId),
    reason: String(r.reason),
    status: String(r.status) as ReportRow["status"],
    reporter: String(r.reporter),
    targetTitle: String(r.targetTitle ?? "（内容已不存在）"),
    createdAt: String(r.createdAt ?? "—"),
  }));
}

export type AdminActionLogRow = {
  id: number;
  admin: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: string | null;
  createdAt: string;
};

/** 最近管理操作审计日志 */
export async function adminListActions(limit = 30): Promise<AdminActionLogRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT g.id, COALESCE(u.nickname, '未知') AS admin, g.action,
            g.target_type AS targetType, g.target_id AS targetId, g.detail,
            DATE_FORMAT(g.created_at,'%m-%d %H:%i') AS createdAt
     FROM admin_actions g LEFT JOIN users u ON u.id = g.admin_id
     ORDER BY g.created_at DESC LIMIT ${Number(limit) || 30}`
  );
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    admin: String(r.admin),
    action: String(r.action),
    targetType: String(r.targetType),
    targetId: String(r.targetId),
    detail: r.detail ? String(r.detail) : null,
    createdAt: String(r.createdAt ?? "—"),
  }));
}

/** 审核操作：通过 / 驳回（驳回需带原因，会通知作者） */
export async function adminReviewArticle(
  slug: string,
  decision: "approve" | "reject",
  note?: string
): Promise<{ ok: boolean; error?: string; authorId?: number }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库不可用" };
  if (decision === "reject" && !(note ?? "").trim()) {
    return { ok: false, error: "驳回必须填写原因" };
  }
  const reviewStatus = decision === "approve" ? "approved" : "rejected";
  const reviewNote = decision === "approve" ? null : (note ?? "").trim().slice(0, 255);
  const [rows] = await pool.query(
    `UPDATE articles SET review_status = ?, review_note = ? WHERE slug = ?`,
    [reviewStatus, reviewNote, slug]
  );
  const affected = (rows as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) return { ok: false, error: "文章不存在" };
  const [author] = await pool.query(`SELECT author_id FROM articles WHERE slug = ?`, [slug]);
  return {
    ok: true,
    authorId: Number((author as Record<string, unknown>[])[0]?.author_id ?? 0) || undefined,
  };
}

/** 用户管理操作：封禁/解封/加分/扣分（封禁即时生效——getCurrentUser 拒绝 banned 用户） */
export async function adminSetUser(
  userId: number,
  action: "ban" | "unban" | "grant" | "revoke" | "setRole",
  amount?: number,
  newRole?: string
): Promise<{ ok: boolean; error?: string }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库不可用" };
  if (action === "ban") {
    const [r] = await pool.query(`UPDATE users SET banned = 1 WHERE id = ? AND role NOT IN ('admin','developer')`, [userId]);
    if ((r as { affectedRows?: number }).affectedRows === 0) return { ok: false, error: "用户不存在或为管理团队" };
    return { ok: true };
  }
  if (action === "unban") {
    const [r] = await pool.query(`UPDATE users SET banned = 0 WHERE id = ?`, [userId]);
    if ((r as { affectedRows?: number }).affectedRows === 0) return { ok: false, error: "用户不存在" };
    return { ok: true };
  }
  /* v17.1 角色管理（仅 developer 可调用，路由层已二次校验）：
     可把普通用户设为 user/author/admin；developer 身份不可经此授予或修改 */
  if (action === "setRole") {
    const target = String(newRole ?? "").trim();
    if (!["reader", "author", "admin"].includes(target)) {
      return { ok: false, error: "目标角色须为 reader / author / admin" };
    }
    const [cur] = await pool.query(`SELECT role FROM users WHERE id = ?`, [userId]);
    const curRole = String((cur as Record<string, unknown>[])[0]?.role ?? "");
    if (!curRole) return { ok: false, error: "用户不存在" };
    if (curRole === "developer") return { ok: false, error: "开发者身份不可在此变更" };
    const [rr] = await pool.query(`UPDATE users SET role = ? WHERE id = ?`, [target, userId]);
    if ((rr as { affectedRows?: number }).affectedRows === 0) return { ok: false, error: "角色变更失败" };
    return { ok: true };
  }
  const amt = Math.floor(Number(amount) || 0);
  if (amt <= 0 || amt > 100_000) return { ok: false, error: "点墨数量须为 1–100000" };
  const delta = action === "grant" ? amt : -amt;
  // v17.4：余额变更与流水落账收进同一事务；扣减不再用 GREATEST(0,..) 掩盖差额 ——
  // 原写法「账记 -200、余额只掉 50」会让 point_ledger 求和与真实余额永久对不上。
  // 现按真实余额变化记 applied，账面与流水恒等；流水写失败即整体回滚。
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT points_balance FROM users WHERE id = ? FOR UPDATE`,
      [userId]
    );
    const cur = (rows as Record<string, unknown>[])[0];
    if (!cur) {
      await conn.rollback();
      return { ok: false, error: "用户不存在" };
    }
    const before = Number(cur.points_balance ?? 0);
    const after = Math.max(0, before + delta);
    const applied = after - before;
    if (applied === 0) {
      await conn.rollback();
      return { ok: false, error: "该用户余额已为 0，无可扣回的点墨" };
    }
    await conn.query(`UPDATE users SET points_balance = ? WHERE id = ?`, [after, userId]);
    await conn.query(`INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)`, [
      userId,
      applied,
      action === "grant"
        ? `运营发放 ${amt} 点墨`
        : `运营扣回 ${-applied} 点墨${applied !== delta ? `（请求 ${amt}，余额不足按实际扣减）` : ""}`,
    ]);
    await conn.commit();
    return { ok: true };
  } catch {
    await conn.rollback();
    return { ok: false, error: "点墨调整失败，请稍后再试" };
  } finally {
    conn.release();
  }
}

/* ==================== v17.1 运营台扩展：资金 / 评论 / 改价 ==================== */

export type AdminOrderRow = {
  kind: string; // 充值 / 单篇解锁 / 专栏打包
  user: string;
  title: string;
  amount: number; // 花费点墨
  gain: number; // 作者分成
  createdAt: string;
};

/** 资金流水：充值 + 单篇解锁 + 专栏打包，合并最近 60 条 */
export async function adminListOrders(): Promise<AdminOrderRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `(SELECT '充值' AS kind, u.nickname AS user, IFNULL(p.name, o.pack_key) AS title,
              o.points AS amount, 0 AS gain,
              DATE_FORMAT(o.paid_at,'%m-%d %H:%i') AS createdAt
         FROM topup_orders o JOIN users u ON u.id = o.user_id
         LEFT JOIN (SELECT 'starter' AS k,'体验包' AS name UNION ALL SELECT 'standard','标准包' UNION ALL SELECT 'pro','创作包') p
           ON p.k = o.pack_key
        WHERE o.status = 'paid')
       UNION ALL
       (SELECT '单篇解锁', u.nickname, a.title, ap.price, ap.author_gain,
              DATE_FORMAT(ap.created_at,'%m-%d %H:%i')
         FROM article_purchases ap JOIN users u ON u.id = ap.user_id
         JOIN articles a ON a.id = ap.article_id)
       UNION ALL
       (SELECT '专栏打包', u.nickname, s.title, sp.price, sp.author_gain,
              DATE_FORMAT(sp.created_at,'%m-%d %H:%i')
         FROM series_purchases sp JOIN users u ON u.id = sp.user_id
         JOIN series s ON s.id = sp.series_id)
       ORDER BY createdAt DESC LIMIT 60`
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      kind: String(r.kind),
      user: String(r.user),
      title: String(r.title),
      amount: Number(r.amount ?? 0),
      gain: Number(r.gain ?? 0),
      createdAt: String(r.createdAt),
    }));
  } catch {
    return [];
  }
}

export type AdminCommentRow = {
  id: number;
  author: string;
  articleSlug: string;
  articleTitle: string;
  content: string;
  createdAt: string;
};

/** 最近评论（运营管理用） */
export async function adminListComments(): Promise<AdminCommentRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT c.id, IFNULL(u.nickname, IFNULL(c.guest_nickname,'旅人')) AS author,
              a.slug AS articleSlug, a.title AS articleTitle,
              LEFT(c.content, 120) AS content,
              DATE_FORMAT(c.created_at,'%m-%d %H:%i') AS createdAt
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       JOIN articles a ON a.id = c.article_id
       ORDER BY c.created_at DESC LIMIT 60`
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      author: String(r.author),
      articleSlug: String(r.articleSlug),
      articleTitle: String(r.articleTitle),
      content: String(r.content),
      createdAt: String(r.createdAt),
    }));
  } catch {
    return [];
  }
}

/** 删除评论（含一级回复），并回扣文章评论计数 */
export async function adminDeleteComment(commentId: number): Promise<{ ok: boolean; error?: string; removed?: number }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库不可用" };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT article_id FROM comments WHERE id = ? FOR UPDATE`, [commentId]);
    const c = (rows as { article_id: number }[])[0];
    if (!c) {
      await conn.rollback();
      return { ok: false, error: "评论不存在" };
    }
    const [del] = await conn.query(
      `DELETE FROM comments WHERE id = ? OR parent_id = ?`,
      [commentId, commentId]
    );
    const removed = Number((del as { affectedRows?: number }).affectedRows ?? 0);
    await conn.query(
      `UPDATE articles SET comment_count = GREATEST(0, comment_count - ?) WHERE id = ?`,
      [removed, c.article_id]
    );
    await conn.commit();
    return { ok: true, removed };
  } catch {
    await conn.rollback();
    return { ok: false, error: "删除失败" };
  } finally {
    conn.release();
  }
}

/** 运营改价：单篇解锁价 / 限时折扣（0 = 关闭付费墙） */
export async function adminSetArticlePrice(
  slug: string,
  unlockPrice: number,
  discountPrice: number
): Promise<{ ok: boolean; error?: string }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库不可用" };
  const up = Math.floor(Number(unlockPrice) || 0);
  const dp = Math.floor(Number(discountPrice) || 0);
  if (up < 0 || up > 100_000 || dp < 0 || dp > up) {
    return { ok: false, error: "价格须为 0–100000，且折扣价 ≤ 解锁价" };
  }
  const [r] = await pool.query(
    `UPDATE articles SET unlock_price = ?, discount_price = ?, discount_until = ? WHERE slug = ?`,
    [up, dp, dp > 0 ? DATE_AFTER_DAYS(7) : null, slug]
  );
  if ((r as { affectedRows?: number }).affectedRows === 0) return { ok: false, error: "文章不存在" };
  return { ok: true };
}

/** 折扣截止：N 天后（SQL 表达式工具） */
function DATE_AFTER_DAYS(days: number): string {
  const d = new Date(Date.now() + days * 86400_000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** 举报目标：按 slug 定位已发布文章，或按 id 定位评论 */
export type ReportTarget = { type: "article"; slug: string } | { type: "comment"; commentId: number };

/**
 * 读者举报入库（单事务 + 目标行 FOR UPDATE 串行化）。
 *
 * v18.0：原实现是「SELECT 查重复 → INSERT」两条各自自动提交的语句，两句之间既无行锁
 * 也无唯一键。实测 20 并发提交同一目标：评论举报落库 **10 行**、文章举报落库 **17 行**
 * （都应只 1 行）——注释里「同一用户对同一目标的未处理举报只保留一条」的承诺是假的，
 * 举报人一次并发即可把运营台处理队列灌满（middleware 的 120 次/分/IP 限流拦不住
 * 同一 key 的并发突发）。
 *
 * 现在：整段收进单事务，先对目标行（文章/评论主键）FOR UPDATE 取锁——
 * 同一目标的并发举报在此排队，后到者的重复检查必然读到先到者已提交的 open 行，
 * 于是返回 duplicate 而不落库。
 *
 * 注意：去重口径只在 `status='open'` 上——举报被处理后（resolved/dismissed），
 * 同一用户应当可以再次举报，所以**不能**用普通唯一索引（MySQL 无部分索引）。
 */
export async function submitReport(
  reporterId: number,
  target: ReportTarget,
  reason: string
): Promise<{ ok: true } | { ok: false; code: "not_found" | "duplicate" | "db" }> {
  const pool = await getPool();
  if (!pool) return { ok: false, code: "db" };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 锁锚点：目标行本身。同目标的并发举报在此排队。
    const anchorSql =
      target.type === "article"
        ? `SELECT id FROM articles WHERE slug = ? AND status = 'published' LIMIT 1 FOR UPDATE`
        : `SELECT id FROM comments WHERE id = ? LIMIT 1 FOR UPDATE`;
    const anchorArg = target.type === "article" ? target.slug : target.commentId;
    const [anchorRows] = await conn.query(anchorSql, [anchorArg]);
    const anchor = (anchorRows as { id: number }[])[0];
    if (!anchor) {
      await conn.rollback();
      return { ok: false, code: "not_found" };
    }
    const [dup] = await conn.query(
      `SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open' LIMIT 1`,
      [reporterId, target.type, anchor.id]
    );
    if ((dup as unknown[]).length > 0) {
      await conn.rollback();
      return { ok: false, code: "duplicate" };
    }
    await conn.query(`INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)`, [
      reporterId,
      target.type,
      anchor.id,
      reason,
    ]);
    await conn.commit();
    return { ok: true };
  } catch {
    await conn.rollback().catch(() => {});
    return { ok: false, code: "db" };
  } finally {
    conn.release();
  }
}

/** 举报处理：删除内容 / 保留内容仅忽略 / 直接关闭 */
export async function adminHandleReport(
  reportId: number,
  handle: "delete_content" | "keep" | "dismiss",
  note?: string
): Promise<{ ok: boolean; error?: string }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库不可用" };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, target_type AS targetType, target_id AS targetId FROM reports WHERE id = ? FOR UPDATE`,
      [reportId]
    );
    const rep = (rows as { id: number; targetType: string; targetId: number }[])[0];
    if (!rep) {
      await conn.rollback();
      return { ok: false, error: "举报不存在" };
    }
    if (handle === "delete_content") {
      if (rep.targetType === "article") {
        await conn.query(`UPDATE articles SET status='removed', pinned=0, featured=0 WHERE id = ?`, [rep.targetId]);
      } else {
        await conn.query(`DELETE FROM comments WHERE id = ?`, [rep.targetId]);
      }
      await conn.query(`UPDATE reports SET status='resolved', handle_note=?, handled_at=NOW() WHERE id = ?`, [
        (note ?? "已删除被举报内容").slice(0, 255),
        reportId,
      ]);
    } else if (handle === "keep") {
      await conn.query(`UPDATE reports SET status='resolved', handle_note=?, handled_at=NOW() WHERE id = ?`, [
        (note ?? "核查后保留内容").slice(0, 255),
        reportId,
      ]);
    } else {
      await conn.query(`UPDATE reports SET status='dismissed', handle_note=?, handled_at=NOW() WHERE id = ?`, [
        (note ?? "无效举报").slice(0, 255),
        reportId,
      ]);
    }
    await conn.commit();
    return { ok: true };
  } catch {
    await conn.rollback();
    return { ok: false, error: "处理失败（数据库异常）" };
  } finally {
    conn.release();
  }
}

/** 管理操作审计日志（运营台所有敏感动作调用） */
export async function logAdminAction(
  adminId: number,
  action: string,
  targetType: string,
  targetId: string | number,
  detail?: string
): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)`,
      [adminId, action.slice(0, 64), targetType.slice(0, 32), String(targetId).slice(0, 64), detail?.slice(0, 500) ?? null]
    );
  } catch {
    /* 日志失败静默 */
  }
}

/* ---------- 首页：平台数据横幅 ---------- */

export type PlatformStats = { articles: number; authors: number; qaTotal: number; tipsTotal: number };

export async function platformStats(): Promise<PlatformStats> {
  const pool = await getPool();
  if (!pool) return { articles: 0, authors: 0, qaTotal: 0, tipsTotal: 0 };
  try {
    const [rows] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM articles WHERE status = 'published' AND review_status = 'approved') AS articles,
         (SELECT COUNT(DISTINCT author_id) FROM articles WHERE status = 'published') AS authors,
         (SELECT COUNT(*) FROM agent_qa) AS qaTotal,
         (SELECT IFNULL(SUM(amount),0) FROM article_tips) AS tipsTotal`
    );
    const r = (rows as Record<string, unknown>[])[0] ?? {};
    return {
      articles: Number(r.articles ?? 0),
      authors: Number(r.authors ?? 0),
      qaTotal: Number(r.qaTotal ?? 0),
      tipsTotal: Number(r.tipsTotal ?? 0),
    };
  } catch {
    return { articles: 0, authors: 0, qaTotal: 0, tipsTotal: 0 };
  }
}

/* ---------- 首页：作者榜（按获赞） ---------- */

export type AuthorRankRow = {
  id: number;
  nickname: string;
  avatarText: string;
  avatarTone: string;
  avatarShape: string;
  likes: number;
  articles: number;
  readTotal: number;
};

export async function topAuthors(limit = 5): Promise<AuthorRankRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensureAvatarColumns(pool);
    const [rows] = await pool.query(
      `SELECT u.id, u.nickname, u.avatar_text AS avatarText,
              COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
              IFNULL(SUM(a.like_count),0) AS likes,
              COUNT(a.id) AS articles,
              IFNULL(SUM(a.read_count),0) AS readTotal
       FROM articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'published' AND a.review_status = 'approved'
       GROUP BY a.author_id, u.id, u.nickname, u.avatar_text, u.avatar_tone, u.avatar_shape
       ORDER BY likes DESC, readTotal DESC
       LIMIT ?`,
      [limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      nickname: String(r.nickname),
      avatarText: String(r.avatarText ?? "墨"),
      avatarTone: String(r.avatarTone ?? ""),
      avatarShape: String(r.avatarShape ?? ""),
      likes: Number(r.likes ?? 0),
      articles: Number(r.articles ?? 0),
      readTotal: Number(r.readTotal ?? 0),
    }));
  } catch {
    return [];
  }
}

/* ---------- 全站搜索（标题/摘要/正文 LIKE，游客可用） ---------- */

export type SearchResultRow = {
  slug: string;
  title: string;
  summary: string;
  author: string;
  authorId?: number;
  readCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
  /** 命中片段（正文截取，供结果摘要展示） */
  hit: string | null;
  /** 文章标签（供类别筛选与结果卡展示） */
  tags: string[];
  /** 付费解锁定价（0 = 免费文章） */
  unlockPrice: number;
};

/** 全站搜索（标题/摘要/正文 LIKE）。viewerId 用于付费墙判定：
 *  付费文在「非作者且未购买」时不参与正文匹配、也不返回正文摘录。 */
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

/* ---------- 关注系统：作者与读者建立长期连接（留存核心） ---------- */

export type FollowStats = { followers: number; following: number };

/** 某作者的粉丝/关注计数 */
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

/** viewer 是否已关注 target */
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

/** 关注/取关（toggle）。返回关注后的最新状态 */
export async function toggleFollow(
  followerId: number,
  followeeId: number
): Promise<{ ok: boolean; following?: boolean; error?: string }> {
  if (followerId === followeeId) return { ok: false, error: "不能关注自己" };
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库不可用" };
  try {
    const [ex] = await pool.query(
      `SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ? LIMIT 1`,
      [followerId, followeeId]
    );
    if (Array.isArray(ex) && ex.length > 0) {
      await pool.query(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`, [followerId, followeeId]);
      return { ok: true, following: false };
    }
    await pool.query(
      `INSERT IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)`,
      [followerId, followeeId]
    );
    return { ok: true, following: true };
  } catch {
    return { ok: false, error: "操作失败（数据库异常）" };
  }
}

/** 关注我的人（个人中心·粉丝列表） */
export async function listMyFollowers(userId: number, limit = 50): Promise<
  { id: number; nickname: string; avatarText: string; avatarTone: string; avatarShape: string; bio: string; articles: number }[]
> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensureAvatarColumns(pool);
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

/** 我关注的人（个人中心足迹） */
export async function listMyFollowing(userId: number, limit = 50): Promise<
  { id: number; nickname: string; avatarText: string; avatarTone: string; avatarShape: string; bio: string; articles: number }[]
> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensureAvatarColumns(pool);
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

/** 我点赞过的文章（个人中心足迹） */
export async function listMyLikes(userId: number, limit = 30): Promise<
  { slug: string; title: string; author: string; readCount: number }[]
> {
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

/** 我发表过的评论（个人中心足迹，带文章上下文） */
export async function listMyComments(userId: number, limit = 30): Promise<
  { id: number; content: string; createdAt: string; articleSlug: string; articleTitle: string }[]
> {
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

/* ---------- 书签收藏：懒建表（dev 免手动迁移，进程内只建一次） ---------- */

const gBm = globalThis as unknown as { __inkBmReady?: boolean };

async function ensureBookmarksTable(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>): Promise<void> {
  if (gBm.__inkBmReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS bookmarks (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    article_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_bm (user_id, article_id),
    INDEX idx_bm_user (user_id, created_at DESC),
    CONSTRAINT fk_bm_article FOREIGN KEY (article_id) REFERENCES articles(id)
  ) ENGINE=InnoDB`);
  gBm.__inkBmReady = true;
}

/** 收藏/取消收藏（toggle），返回最新状态 */
export async function toggleBookmark(userId: number, slug: string): Promise<{ bookmarked: boolean }> {
  const pool = await getPool();
  if (!pool) return { bookmarked: false };
  await ensureBookmarksTable(pool);
  // v17.5：必须限定 status='published'。原实现只按 slug 命中，于是草稿（乃至 removed）
  //   也能被收藏——文章页对它们本就 404，收藏按钮无处可达，但接口可直接打；
  //   更糟的是这会往 bookmarks 里种下外键子行，让作者的草稿硬删被 FK RESTRICT 挡下。
  //   与 like / tip / boost / unlock 的公开态口径保持一致。
  const [artRows] = await pool.query(
    `SELECT id FROM articles WHERE slug = ? AND status = 'published' LIMIT 1`,
    [slug]
  );
  const art = (artRows as Record<string, unknown>[])[0];
  if (!art) return { bookmarked: false };
  const articleId = Number(art.id);
  // v17.9：改为「INSERT IGNORE 判态、失败再删」。
  //   原实现是「先 SELECT 判是否已收藏 → 再裸 INSERT」，两条语句之间无锁：
  //   并发/双击（或前端重试）时两个请求都判为「未收藏」，后到者撞唯一键 uk_bm
  //   抛 ER_DUP_ENTRY，被路由 catch 成 500「收藏失败，请稍后再试」。
  //   实测 20 并发首次收藏 → 1 成功 / 19 抛 ER_DUP_ENTRY。
  //   唯一键本身已保证不会重复，这里只需让「重复插入」不再变成异常；
  //   与 toggleFollow 的 INSERT IGNORE 写法保持一致。
  //
  // v18.0：上面的写法解决了 ER_DUP_ENTRY，但留下另一条失败路径——**ER_LOCK_DEADLOCK**。
  //   `INSERT IGNORE` 撞到已存在的行时，InnoDB 要先对那一行取**共享锁**判定唯一键；
  //   紧接着的 `DELETE` 又要把它升级成**排他锁**。N 个并发请求各持一把 S 锁、
  //   又都想要 X 锁，于是成环死锁。实测同一 (user, article) 20 并发：
  //   **10/20 抛 ER_LOCK_DEADLOCK**，被路由 catch 成 500「收藏失败，请稍后再试」。
  //   （对照：toggleFollow / toggleCommentLike 20 并发零错误——它们只在「已存在」时
  //     DELETE、只在「不存在」时 INSERT，不构成 S→X 升级。）
  //   死锁是 InnoDB 的正常现象，官方给的解法就是**重放**；此处按语句重试 3 次并带抖动退避，
  //   仅在「确实撞上可重试锁错误」时才多花一次往返。
  //   重放语义安全：死锁会整条回滚该语句，状态不变；重放后再判一次态即得正确结果
  //   （若前一次 INSERT 已成功、只死在 DELETE 上，重放的 INSERT IGNORE 会返回 0 并走 DELETE，
  //    最终状态仍是「已取消收藏」，与 toggle 意图一致）。
  for (let attempt = 0; ; attempt++) {
    try {
      const [ins] = await pool.query(`INSERT IGNORE INTO bookmarks (user_id, article_id) VALUES (?, ?)`, [
        userId,
        articleId,
      ]);
      if (Number((ins as { affectedRows?: number }).affectedRows ?? 0) === 1) {
        return { bookmarked: true };
      }
      await pool.query(`DELETE FROM bookmarks WHERE user_id = ? AND article_id = ?`, [userId, articleId]);
      return { bookmarked: false };
    } catch (e) {
      if (!isRetryableLockError(e) || attempt >= 2) throw e;
      await sleepMs(5 + Math.floor(Math.random() * 25) * (attempt + 1));
    }
  }
}

/** viewer 是否收藏了某篇 */
export async function isBookmarked(userId: number | null, slug: string): Promise<boolean> {
  if (!userId) return false;
  const pool = await getPool();
  if (!pool) return false;
  try {
    await ensureBookmarksTable(pool);
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

/** 我的收藏列表（个人中心足迹） */
export async function listMyBookmarks(userId: number, limit = 50): Promise<
  { slug: string; title: string; author: string; readCount: number; savedAt: string }[]
> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensureBookmarksTable(pool);
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

/* ---------- 阅读历史「最近读过」（read_history 懒建表） ---------- */

type HistoryPool = NonNullable<Awaited<ReturnType<typeof getPool>>>;
const gHist = globalThis as unknown as { __inkHistReady?: boolean };

async function ensureHistoryTable(pool: HistoryPool): Promise<void> {
  if (gHist.__inkHistReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS read_history (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    article_id BIGINT UNSIGNED NOT NULL,
    read_times INT UNSIGNED NOT NULL DEFAULT 1,
    read_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_rh (user_id, article_id),
    INDEX idx_rh_user (user_id, read_at DESC),
    CONSTRAINT fk_rh_article FOREIGN KEY (article_id) REFERENCES articles(id)
  ) ENGINE=InnoDB`);
  gHist.__inkHistReady = true;
}

/** 记录一次阅读（同人同文去重，累计次数 + 刷新最近时间） */
export async function recordRead(userId: number, slug: string): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await ensureHistoryTable(pool);
    await pool.query(
      `INSERT INTO read_history (user_id, article_id, read_times, read_at)
       SELECT ?, id, 1, NOW() FROM articles WHERE slug = ? AND status = 'published'
       ON DUPLICATE KEY UPDATE read_times = read_times + 1, read_at = NOW()`,
      [userId, slug]
    );
  } catch {
    /* 静默失败：阅读记录不影响主流程 */
  }
}

/** 我的阅读足迹（个人中心「最近读过」） */
export async function listMyHistory(userId: number, limit = 30): Promise<
  { slug: string; title: string; author: string; readCount: number; readAt: string; times: number }[]
> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensureHistoryTable(pool);
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

/* ---------- 作者作品数据（创作台看板） ---------- */

export type AuthorArticleStat = {
  slug: string;
  title: string;
  status: string;
  publishedAt: string;
  readCount: number;
  likeCount: number;
  commentCount: number;
  tipTotal: number;
  boostUntil: string | null;
};

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

/* ---------- 热榜 /hot：按时间窗排序热度 ---------- */

export type HotRange = "day" | "week" | "all";

/** 热度 = 阅读 + 点赞×5 + 评论×5 + 分身问答×10 + 打赏×3，仅统计时间窗内发表的文章 */
export async function listHot(range: HotRange = "day", limit = 20): Promise<ArticleRow[]> {
  const all = await listArticles();
  const published = all.filter((a) => a.reviewStatus === undefined || a.reviewStatus === "approved");
  const now = Date.now();
  const windowMs = range === "day" ? 24 * 3.6e6 : range === "week" ? 7 * 24 * 3.6e6 : Infinity;
  const inWindow = published.filter((a) => {
    if (range === "all") return true;
    const t = new Date(a.publishedAt + "T08:00:00+08:00").getTime();
    return Number.isFinite(t) && now - t <= windowMs;
  });
  const heat = (a: ArticleRow) =>
    a.readCount + (a.likeCount ?? 0) * 5 + a.commentCount * 5 + a.agentQaCount * 10 + (a.tipTotal ?? 0) * 3;
  return inWindow.sort((a, b) => heat(b) - heat(a) || b.readCount - a.readCount).slice(0, limit);
}

/* ---------- 作者主页 /author/[id] ---------- */

export type AuthorProfile = {
  id: number;
  nickname: string;
  avatarText: string;
  avatarTone: string;
  avatarShape: string;
  bio: string;
  createdAt: string;
  articles: number;
  likes: number;
  readTotal: number;
};

export async function getAuthor(id: number): Promise<AuthorProfile | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const pool = await getPool();
  if (!pool) return null;
  try {
    await ensureAvatarColumns(pool);
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

/** 某作者的公开文章（仅 approved），按发布时间倒序 */
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

/* ---------- 首页关注动态流：我关注的作者的最新文章 ---------- */

export type FeedItem = {
  slug: string;
  title: string;
  summary: string;
  authorId: number;
  author: string;
  authorAvatar: string;
  publishedAt: string;
  readCount: number;
  likeCount: number;
  commentCount: number;
};

export async function listFollowingFeed(userId: number, limit = 8): Promise<FeedItem[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT a.slug, a.title, a.summary, a.author_id AS authorId,
              u.nickname AS author, u.avatar_text AS authorAvatar,
              DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
              a.read_count AS readCount, a.like_count AS likeCount, a.comment_count AS commentCount
       FROM follows f
       JOIN articles a ON a.author_id = f.followee_id
       JOIN users u ON u.id = a.author_id
       WHERE f.follower_id = ? AND a.status = 'published' AND a.review_status = 'approved'
       ORDER BY a.published_at DESC LIMIT ?`,
      [userId, limit]
    );
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      summary: String(r.summary ?? ""),
      authorId: Number(r.authorId),
      author: String(r.author),
      authorAvatar: String(r.authorAvatar ?? "墨"),
      publishedAt: dateOnly(r.publishedAt),
      readCount: Number(r.readCount ?? 0),
      likeCount: Number(r.likeCount ?? 0),
      commentCount: Number(r.commentCount ?? 0),
    }));
  } catch {
    return [];
  }
}

/* ============================================================
   成就徽章系统：按用户数据实时计算，不需要建表
   ============================================================ */

export type Achievement = {
  key: string;
  name: string;
  desc: string;
  icon: string;
  /** 已达成 */
  earned: boolean;
  /** 进度 0~1 */
  progress: number;
  progressText: string;
};

export async function listAchievements(userId: number): Promise<Achievement[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const results = await Promise.all([
      pool.query(
        `SELECT COUNT(*) n, IFNULL(SUM(read_count),0) rd FROM articles
         WHERE author_id = ? AND status='published' AND review_status='approved'`,
        [userId]
      ),
      pool.query(
        `SELECT IFNULL(SUM(a.like_count),0) n FROM articles a
         WHERE a.author_id = ? AND a.status='published' AND a.review_status='approved'`,
        [userId]
      ),
      pool.query(
        `SELECT IFNULL(SUM(a.comment_count),0) n FROM articles a
         WHERE a.author_id = ? AND a.status='published' AND a.review_status='approved'`,
        [userId]
      ),
      pool.query(`SELECT checkin_date FROM checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 30`, [userId]),
      pool.query(`SELECT points_balance FROM users WHERE id = ?`, [userId]),
      pool.query(`SELECT COUNT(*) n FROM follows WHERE follower_id = ?`, [userId]),
      pool.query(`SELECT COUNT(*) n FROM follows WHERE followee_id = ?`, [userId]),
      pool.query(`SELECT COUNT(*) n FROM agent_qa WHERE asker_id = ?`, [userId]),
    ]);
    const num = (res: unknown, field = "n") =>
      Number(((res as unknown as [Record<string, unknown>[]])[0] as Record<string, unknown>[])[0]?.[field] ?? 0);
    const arts = num(results[0]);
    const reads = num(results[0], "rd");
    const likes = num(results[1]);
    const cmts = num(results[2]);
    const balance = num(results[4]);
    const followingN = num(results[5]);
    const fansN = num(results[6]);
    const qaN = num(results[7]);

    // 连续签到：从今天（或昨天）往回数连续签到日
    const rows = (results[3] as unknown as [Record<string, unknown>[]])[0] ?? [];
    const dset = new Set(rows.map((r) => String(r.checkin_date).slice(0, 10)));
    const iso = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    };
    let streak = 0;
    let offset = dset.has(iso(0)) ? 0 : dset.has(iso(1)) ? 1 : -1;
    if (offset >= 0) {
      while (offset < 30 && dset.has(iso(offset))) {
        streak++;
        offset++;
      }
    }

    const mk = (key: string, name: string, desc: string, icon: string, cur: number, goal: number): Achievement => ({
      key,
      name,
      desc,
      icon,
      earned: cur >= goal,
      progress: Math.min(1, cur / goal),
      progressText: Math.min(cur, goal).toLocaleString() + " / " + goal.toLocaleString(),
    });

    return [
      mk("first-post", "处女作", "发布第一篇公开文章", "初", arts, 1),
      mk("prolific", "笔耕不辍", "累计发布 5 篇文章", "耕", arts, 5),
      mk("voluminous", "著作等身", "累计发布 10 篇文章", "著", arts, 10),
      mk("reads-100", "初露锋芒", "文章总阅读破 100", "锋", reads, 100),
      mk("reads-1000", "洛阳纸贵", "文章总阅读破 1000", "贵", reads, 1000),
      mk("likes-10", "初识知音", "累计获赞 10", "知", likes, 10),
      mk("likes-50", "人气之星", "累计获赞 50", "星", likes, 50),
      mk("talk-10", "谈笑风生", "文章累计被评论 10 次", "谈", cmts, 10),
      mk("streak-3", "三日不辍", "连续签到 3 天", "恒", streak, 3),
      mk("streak-7", "七日之约", "连续签到 7 天", "约", streak, 7),
      mk("rich", "墨水富翁", "墨水余额达 1000 滴", "富", balance, 1000),
      mk("social", "以文会友", "关注 3 位作者", "友", followingN, 3),
      mk("beloved", "众望所归", "收获 5 位粉丝", "望", fansN, 5),
      mk("curious", "十问分身", "与分身问答 10 次", "问", qaN, 10),
    ];
  } catch {
    return [];
  }
}

/* ============================================================
   今日墨签：按日期确定性抽取的每日一句（无需建表）
   ============================================================ */

export const INK_QUOTES: { text: string; from: string }[] = [
  { text: "写作是把心里的一团雾，慢慢熬成一杯看得见底的茶。", from: "墨栈·创刊号" },
  { text: "好文章不是写出来的，是改到第三稿时突然长出来的。", from: "墨栈·改稿札记" },
  { text: "读者不欠你耐心，你要欠读者一个好故事。", from: "墨栈·编辑部手记" },
  { text: "每天写三百字的人，一年后已经甩开了大多数只想不做的人。", from: "墨栈·日课" },
  { text: "标题是请柬，正文才是宴席，别让客人空手而归。", from: "墨栈·标题课" },
  { text: "灵感像流浪猫，你天天在同一时间放一碗饭，它自然会来。", from: "墨栈·守株待猫论" },
  { text: "删掉最得意的那个句子，文章往往就通了。", from: "墨栈·减法美学" },
  { text: "阅读是最便宜的旅行，写作是最便宜的撒野。", from: "墨栈·纸上远行" },
  { text: "不要等想清楚了再写，写本身就是想清楚的方式。", from: "墨栈·写作即思考" },
  { text: "第一句定了调，最后一句定了回味，中间随便你折腾。", from: "墨栈·首尾课" },
  { text: "被读懂是写作者的瘾，戒不掉的那种。", from: "墨栈·瘾" },
  { text: "空白不是没话讲，是给读者留的座位。", from: "墨栈·留白课" },
  { text: "素材本里躺着的碎片，是未来文章的化石层。", from: "墨栈·采集论" },
  { text: "别怕写得烂，烂稿是所有好稿的必经之路。", from: "墨栈·烂稿宣言" },
  { text: "你写下的每个字都在投票，选出你将成为的那种作者。", from: "墨栈·字投票" },
  { text: "深夜的灵感要当场逮捕，天亮就保释不出来了。", from: "墨栈·夜间执法" },
  { text: "文章的光芒不在辞藻，在于你真的有话想说。", from: "墨栈·诚意课" },
  { text: "修改是把文章从「我写的」变成「它自己长成的」。", from: "墨栈·生长论" },
  { text: "读者的一个问题，常常比一百个赞更值钱。", from: "墨栈·问答课" },
  { text: "坚持公开写作，因为观众会让平淡的日子有回声。", from: "墨栈·回声" },
];

/** 今日墨签：同一日期全站稳定同一句 */
export function todayInkQuote(): { text: string; from: string; dayIndex: number } {
  const now = new Date();
  const seed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const idx = seed % INK_QUOTES.length;
  return { ...INK_QUOTES[idx], dayIndex: idx };
}

/* ============================================================
   集齐徽章奖励：全部 14 枚点亮后可领 100 滴墨水（一次性）
   以 point_ledger 的固定 reason 作为领取凭据，无需新表
   ============================================================ */

export const BADGE_REWARD_REASON = "集齐徽章奖励";
export const BADGE_REWARD_AMOUNT = 100;

export async function badgeRewardClaimed(userId: number): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  try {
    const [rows] = await pool.query(`SELECT id FROM point_ledger WHERE user_id = ? AND reason = ? LIMIT 1`, [
      userId,
      BADGE_REWARD_REASON,
    ]);
    return Array.isArray(rows) && (rows as unknown[]).length > 0;
  } catch {
    return false;
  }
}

/* ---------- 管理大盘：图表数据（发文/注册/评论趋势、墨水经济、热门榜、标签构成） ---------- */

export type AdminInsights = {
  days: { d: string; label: string; articles: number; users: number; comments: number }[];
  ink: { tipCount: number; tipTotal: number; authorGot: number; topupCount: number; topupTotal: number; qaCount: number };
  topArticles: { slug: string; title: string; author: string; readCount: number; likeCount: number; tipTotal: number }[];
  tags: { tag: string; count: number }[];
  /** 全站付费转化漏斗：在售付费稿 → 付费墙到达 → 单篇解锁 → 专栏打包；revenue 为流水点墨 */
  funnel: { paidArticles: number; paywallViews: number; unlocks: number; bundles: number; revenue: number };
};

const DAYS_WINDOW = 14;

function lastNDays(n: number): { d: string; label: string }[] {
  const out: { d: string; label: string }[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    out.push({ d: iso, label: `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}` });
  }
  return out;
}

export async function adminInsights(): Promise<AdminInsights> {
  const pool = await getPool();
  if (!pool) {
    return {
      days: lastNDays(DAYS_WINDOW).map((x) => ({ ...x, articles: 0, users: 0, comments: 0 })),
      ink: { tipCount: 0, tipTotal: 0, authorGot: 0, topupCount: 0, topupTotal: 0, qaCount: 0 },
      topArticles: [],
      tags: [],
      funnel: { paidArticles: 0, paywallViews: 0, unlocks: 0, bundles: 0, revenue: 0 },
    };
  }
  try {
    const axis = lastNDays(DAYS_WINDOW);
    const idx = new Map(axis.map((a, i) => [a.d, i]));
    const days = axis.map((x) => ({ ...x, articles: 0, users: 0, comments: 0 }));

    const fill = async (sql: string, key: "articles" | "users" | "comments") => {
      const [rows] = await pool.query(sql);
      for (const r of rows as Record<string, unknown>[]) {
        const i = idx.get(String(r.d));
        if (i !== undefined) days[i][key] = Number(r.c);
      }
    };
    await fill(
      `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') d, COUNT(*) c FROM articles
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${DAYS_WINDOW - 1} DAY) GROUP BY d`,
      "articles"
    );
    await fill(
      `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') d, COUNT(*) c FROM users
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${DAYS_WINDOW - 1} DAY) GROUP BY d`,
      "users"
    );
    await fill(
      `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') d, COUNT(*) c FROM comments
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${DAYS_WINDOW - 1} DAY) GROUP BY d`,
      "comments"
    );

    const [inkRows] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM article_tips) AS tipCount,
         (SELECT IFNULL(SUM(amount),0) FROM article_tips) AS tipTotal,
         (SELECT COUNT(*) FROM topup_orders WHERE status='paid') AS topupCount,
         (SELECT IFNULL(SUM(points),0) FROM topup_orders WHERE status='paid') AS topupTotal,
         (SELECT COUNT(*) FROM agent_qa) AS qaCount`
    );
    const ir = ((inkRows as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
    const tipTotal = Number(ir.tipTotal ?? 0);
    const ink = {
      tipCount: Number(ir.tipCount ?? 0),
      tipTotal,
      authorGot: Math.round(tipTotal * 0.9),
      topupCount: Number(ir.topupCount ?? 0),
      topupTotal: Number(ir.topupTotal ?? 0),
      qaCount: Number(ir.qaCount ?? 0),
    };

    const [topRows] = await pool.query(
      `SELECT a.slug, a.title, IFNULL(u.nickname,'佚名') AS author, a.read_count, a.like_count,
              IFNULL((SELECT SUM(amount) FROM article_tips t WHERE t.article_id = a.id), 0) AS tipTotal
       FROM articles a LEFT JOIN users u ON u.id = a.author_id
       WHERE a.status='published' AND a.review_status='approved'
       ORDER BY a.read_count DESC LIMIT 5`
    );
    const topArticles = (topRows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      author: String(r.author),
      readCount: Number(r.read_count),
      likeCount: Number(r.like_count),
      tipTotal: Number(r.tipTotal),
    }));

    const [tagRows] = await pool.query(
      `SELECT tags FROM articles WHERE status='published' AND review_status='approved' AND tags IS NOT NULL`
    );
    const counter = new Map<string, number>();
    for (const r of tagRows as Record<string, unknown>[]) {
      const list = Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [];
      for (const t of list) counter.set(t, (counter.get(t) ?? 0) + 1);
    }
    const tags = [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // 全站付费转化漏斗（series_purchases 为运行时懒建表，缺失时降级为单篇口径）
    let funnel: AdminInsights["funnel"] = { paidArticles: 0, paywallViews: 0, unlocks: 0, bundles: 0, revenue: 0 };
    try {
      await ensurePaidColumns(pool);
      const [fRows] = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='approved' AND IFNULL(unlock_price,0)>0) AS paidArticles,
           (SELECT IFNULL(SUM(IFNULL(paywall_views,0)),0) FROM articles WHERE IFNULL(unlock_price,0)>0 AND status <> 'deleted') AS paywallViews,
           (SELECT COUNT(*) FROM article_purchases) AS unlocks,
           (SELECT IFNULL(SUM(price),0) FROM article_purchases) AS unlockRevenue,
           (SELECT COUNT(*) FROM series_purchases) AS bundles,
           (SELECT IFNULL(SUM(price),0) FROM series_purchases) AS bundleRevenue`
      );
      const f = ((fRows as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
      funnel = {
        paidArticles: Number(f.paidArticles ?? 0),
        paywallViews: Number(f.paywallViews ?? 0),
        unlocks: Number(f.unlocks ?? 0),
        bundles: Number(f.bundles ?? 0),
        revenue: Number(f.unlockRevenue ?? 0) + Number(f.bundleRevenue ?? 0),
      };
    } catch {
      /* 漏斗统计失败保底空数据 */
    }

    return { days, ink, topArticles, tags, funnel };
  } catch {
    return {
      days: lastNDays(DAYS_WINDOW).map((x) => ({ ...x, articles: 0, users: 0, comments: 0 })),
      ink: { tipCount: 0, tipTotal: 0, authorGot: 0, topupCount: 0, topupTotal: 0, qaCount: 0 },
      topArticles: [],
      tags: [],
      funnel: { paidArticles: 0, paywallViews: 0, unlocks: 0, bundles: 0, revenue: 0 },
    };
  }
}

/* ============================================================
   专栏合集（series）：懒建表 + 合集架 / 落地页 / 书房管理 / 文章页导航
   ============================================================ */

type SeriesPool = NonNullable<Awaited<ReturnType<typeof getPool>>>;

const gSeries = globalThis as unknown as { __inkSeriesReady?: boolean };

async function ensureSeriesTables(pool: SeriesPool): Promise<void> {
  if (gSeries.__inkSeriesReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS series (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    author_id   BIGINT UNSIGNED NOT NULL,
    title       VARCHAR(120) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_series_author (author_id),
    CONSTRAINT fk_series_author FOREIGN KEY (author_id) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS series_items (
    series_id  BIGINT UNSIGNED NOT NULL,
    article_id BIGINT UNSIGNED NOT NULL,
    position   INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (series_id, article_id),
    CONSTRAINT fk_si_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
    CONSTRAINT fk_si_article FOREIGN KEY (article_id) REFERENCES articles(id)
  ) ENGINE=InnoDB`);
  // 打包价：NULL/0 = 不开放打包；>0 = 一口价解锁全专栏（按购买日篇目快照）
  const [bcol] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'series' AND COLUMN_NAME = 'bundle_price'`
  );
  if (Number((bcol as Record<string, unknown>[])[0]?.c ?? 0) === 0) {
    await pool.query(`ALTER TABLE series ADD COLUMN bundle_price INT NULL`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS series_purchases (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    series_id   BIGINT UNSIGNED NOT NULL,
    user_id     BIGINT UNSIGNED NOT NULL,
    price       INT NOT NULL,
    author_gain INT NOT NULL DEFAULT 0,
    item_count  INT NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_series_purchase (series_id, user_id),
    INDEX idx_sp_user (user_id, created_at DESC),
    CONSTRAINT fk_sp_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
    CONSTRAINT fk_sp_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  gSeries.__inkSeriesReady = true;
}

export type SeriesCard = {
  id: number;
  title: string;
  description: string;
  author: string;
  authorAvatar: string;
  authorId: number;
  articleCount: number;
  totalReads: number;
  /** 打包累计解锁篇目人次（0 = 无打包订单） */
  soldCount: number;
  /** 打包一口价（0 = 未开放打包） */
  bundlePrice: number;
  updatedAt: string;
};

/** 合集架：全站专栏（只统计已发布且过审的篇目），按更新时间排；传 authorId 时只取该作者的 */
export async function listSeries(limit = 60, authorId?: number): Promise<SeriesCard[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensureSeriesTables(pool);
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

export type SeriesItem = { slug: string; title: string; readCount: number; publishedAt: string };

export type SeriesDetail = {
  id: number;
  title: string;
  description: string;
  author: string;
  authorAvatar: string;
  authorId: number;
  items: (SeriesItem & { unlockPrice: number; lockedForViewer: boolean })[];
  /** 打包一口价（null = 未开放打包） */
  bundlePrice: number | null;
  /** 当前浏览者已打包购买过 */
  bundlePurchased: boolean;
  /** 未解锁篇目单买合计（打包盒划线用） */
  fullPrice: number;
  /** 专栏内付费篇目数 */
  paidCount: number;
  /** 打包累计入手人次 */
  soldCount: number;
};

/** 专栏落地页：有序篇目（仅已发布且过审）+ 打包解锁视角 */
export async function getSeriesDetail(id: number, viewer?: { id?: number | null }): Promise<SeriesDetail | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    await ensureSeriesTables(pool);
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

export type MySeries = {
  id: number;
  title: string;
  description: string;
  items: { slug: string; title: string }[];
};

/** 书房管理器：我的专栏 + 各自篇目（含未发布，便于编辑） */
export async function listMySeries(authorId: number): Promise<MySeries[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensureSeriesTables(pool);
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

/** 专栏题名建议：聚合作者已过审文章的标签（≥2 篇才有成柜潜力），按热度取前三 */
export type SeriesTitleSuggestion = { title: string; hint: string };

const SERIES_SUFFIX = ["手记", "研习录", "漫谈", "札记", "专栏"];

export async function suggestSeriesTitles(authorId: number): Promise<SeriesTitleSuggestion[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT tags FROM articles
        WHERE author_id = ? AND status = 'published' AND review_status = 'approved' AND tags IS NOT NULL`,
      [authorId]
    );
    const counter = new Map<string, number>();
    for (const r of rows as Record<string, unknown>[]) {
      const list = Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [];
      for (const t of list) counter.set(t, (counter.get(t) ?? 0) + 1);
    }
    const top = [...counter.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    return top.map(([tag, n], i) => ({
      title: `${tag}${SERIES_SUFFIX[i % SERIES_SUFFIX.length]}`.slice(0, 60),
      hint: `已有 ${n} 篇「${tag}」文章可以成柜`,
    }));
  } catch {
    return [];
  }
}

/** 新建专栏，返回 id */
export async function createSeries(authorId: number, title: string, description: string): Promise<number | null> {
  const pool = await getPool();
  if (!pool) return null;
  await ensureSeriesTables(pool);
  const [res] = await pool.query(`INSERT INTO series (author_id, title, description) VALUES (?, ?, ?)`, [
    authorId,
    title.slice(0, 120),
    description.slice(0, 500),
  ]);
  return Number((res as { insertId: bigint | number }).insertId) || null;
}

/** 更新专栏元信息（仅作者本人） */
export async function updateSeriesMeta(
  id: number,
  authorId: number,
  patch: { title?: string; description?: string; bundlePrice?: number | null }
): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  await ensureSeriesTables(pool);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    args.push(patch.title.slice(0, 120));
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    args.push(patch.description.slice(0, 500));
  }
  if (patch.bundlePrice !== undefined) {
    // null/0 = 关闭打包；1-99999 = 一口价
    const bp = patch.bundlePrice === null ? 0 : Math.floor(Number(patch.bundlePrice) || 0);
    sets.push("bundle_price = ?");
    args.push(bp > 0 && bp <= 99999 ? bp : null);
  }
  if (sets.length === 0) return true;
  args.push(id, authorId);
  const [res] = await pool.query(`UPDATE series SET ${sets.join(", ")} WHERE id = ? AND author_id = ?`, args);
  return Number((res as { affectedRows: number }).affectedRows) > 0;
}

/** 删除专栏（仅作者本人；条目级联删除） */
export async function deleteSeries(id: number, authorId: number): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  await ensureSeriesTables(pool);
  const [res] = await pool.query(`DELETE FROM series WHERE id = ? AND author_id = ?`, [id, authorId]);
  return Number((res as { affectedRows: number }).affectedRows) > 0;
}

/** 重设专栏篇目（整体替换）：仅收本人已发布且过审的文章，按数组顺序定 position */
export async function setSeriesItems(id: number, authorId: number, slugs: string[]): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  await ensureSeriesTables(pool);
  // 重复篇目直接拒绝（原实现靠 `命中行数 !== 入参个数` 间接挡下，语义相同但更隐晦；
  // 且若放任重复进 INSERT，会撞 series_items 主键 (series_id, article_id)）
  if (new Set(slugs).size !== slugs.length) return false;
  // v17.9：整段收进单事务，并对 series 行 FOR UPDATE 串行化同一专栏的重设请求。
  //   原实现是「SELECT 校验归属 → DELETE series_items → SELECT 篇目 id → INSERT」四条
  //   各自自动提交的语句：并发重设（前端双击保存）时 DELETE 各自提交、INSERT 撞主键，
  //   实测 12 并发 → 3 成功 / 9 抛错（ER_DUP_ENTRY + ER_LOCK_DEADLOCK）；更糟的是
  //   某个请求 DELETE 已提交而 INSERT 抛错时，专栏篇目会被清空且不回填（部分写入）。
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [own] = await conn.query(
      `SELECT id FROM series WHERE id = ? AND author_id = ? LIMIT 1 FOR UPDATE`,
      [id, authorId]
    );
    if ((own as unknown[]).length === 0) {
      await conn.rollback();
      return false;
    }
    const idBySlug = new Map<string, number>();
    if (slugs.length > 0) {
      const [ok] = await conn.query(
        `SELECT id, slug FROM articles WHERE author_id = ? AND status = 'published' AND review_status = 'approved'
          AND slug IN (${slugs.map(() => "?").join(",")})`,
        [authorId, ...slugs]
      );
      if ((ok as unknown[]).length !== slugs.length) {
        await conn.rollback();
        return false; // 有不属于自己的或未过审的
      }
      for (const r of ok as Record<string, unknown>[]) idBySlug.set(String(r.slug), Number(r.id));
    }
    await conn.query(`DELETE FROM series_items WHERE series_id = ?`, [id]);
    if (slugs.length > 0) {
      const values = slugs.map((slug, i) => [id, idBySlug.get(slug), i]).filter((v) => typeof v[1] === "number");
      if (values.length > 0) {
        await conn.query(`INSERT INTO series_items (series_id, article_id, position) VALUES ?`, [values]);
      }
    }
    await conn.commit();
    return true;
  } catch {
    await conn.rollback().catch(() => {});
    return false;
  } finally {
    conn.release();
  }
}

export type ArticleSeriesNav = {
  id: number;
  title: string;
  position: number;
  total: number;
  prev: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
};

/** 文章页专栏导航：文章所属专栏 + 上/下篇（取 position 最小的所属专栏） */
export async function getArticleSeriesNav(slug: string): Promise<ArticleSeriesNav | null> {
  const pool = await getPool();
  if (!pool) return null;
  try {
    await ensureSeriesTables(pool);
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

/* ============================ 每周墨报 /weekly ============================ */

export type WeeklyReport = {
  /** 本期起始（7 天前）与截止（今天），YYYY-MM-DD */
  from: string;
  to: string;
  /** 期号：以 2026-06-29（周一）为第 1 期起点 */
  issue: number;
  newArticles: number;
  newUsers: number;
  newComments: number;
  tipCount: number;
  tipInk: number;
  newSeries: number;
  /** 本周热度 TOP5 */
  top: ArticleRow[];
  /** 本周新刊（最新发布，最多 8 条，仅本周内） */
  latest: ArticleRow[];
  /** 新上架专栏（最多 3 个） */
  series: SeriesCard[];
  /** 近 6 周发文量（老→新） */
  weeks: { label: string; count: number }[];
};

function weeklyFmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

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
  const top = await listHot("week", 5);
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

/* ============================ 付费解锁（墨水付费墙） ============================ */

const gPaid = globalThis as unknown as { __inkPaidReady?: boolean };

/** 懒建：articles.unlock_price 列 + article_purchases 购买表（进程内只跑一次；写入 API 前置调用） */
export async function ensurePaidColumns(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>): Promise<void> {
  if (gPaid.__inkPaidReady) return;
  const [col] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'articles' AND COLUMN_NAME = 'unlock_price'`
  );
  if (Number((col as Record<string, unknown>[])[0]?.c ?? 0) === 0) {
    await pool.query(`ALTER TABLE articles ADD COLUMN unlock_price INT NOT NULL DEFAULT 0`);
  }
  // 早鸟价：折扣价 + 截止时间（到点自动回到原价）
  const [dcol] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'articles' AND COLUMN_NAME IN ('discount_price','discount_until')`
  );
  const have = new Set((dcol as { COLUMN_NAME: string }[]).map((r) => r.COLUMN_NAME));
  if (!have.has("discount_price")) await pool.query(`ALTER TABLE articles ADD COLUMN discount_price INT NULL`);
  if (!have.has("discount_until")) await pool.query(`ALTER TABLE articles ADD COLUMN discount_until DATETIME NULL`);
  // 转化漏斗：付费墙到达计数
  const [pcol] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'articles' AND COLUMN_NAME = 'paywall_views'`
  );
  if (Number((pcol as Record<string, unknown>[])[0]?.c ?? 0) === 0) {
    await pool.query(`ALTER TABLE articles ADD COLUMN paywall_views INT NOT NULL DEFAULT 0`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS article_purchases (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    article_id BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    price      INT NOT NULL,
    author_gain INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_purchase (article_id, user_id),
    INDEX idx_pur_user (user_id, created_at DESC),
    CONSTRAINT fk_pur_article FOREIGN KEY (article_id) REFERENCES articles(id),
    CONSTRAINT fk_pur_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  gPaid.__inkPaidReady = true;
}

export type UnlockResult =
  | { ok: true; price: number; authorGot: number; balance: number }
  | { ok: false; error: string };

/** 解锁付费文章：读者付 unlock_price，作者得 70%，平台 30%（购过幂等返回成功）
 *  v15.0：全程单事务原子化——先 INSERT 占位（唯一键判重防并发双花），
 *  再 FOR UPDATE 扣款 + 分账 + 流水，任一步失败整体回滚。 */
export async function unlockArticle(slug: string, userId: number): Promise<UnlockResult> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库暂不可用" };
  try {
    await ensurePaidColumns(pool);
    const [rows] = await pool.query(
      `SELECT id, author_id, IFNULL(unlock_price,0) AS price, IFNULL(discount_price,0) AS dprice,
              discount_until AS duntil
         FROM articles
        WHERE slug = ? AND status = 'published' AND (review_status = 'approved' OR review_status IS NULL) LIMIT 1`,
      [slug]
    );
    const art = (rows as { id: number; author_id: number; price: number; dprice: number; duntil: Date | string | null }[])[0];
    if (!art) return { ok: false, error: "文章不存在或未公开" };
    const price = effectiveUnlockPrice({
      unlockPrice: Number(art.price),
      discountPrice: Number(art.dprice ?? 0),
      discountUntil: art.duntil ? new Date(art.duntil).toISOString() : null,
    });
    if (Number(art.price) <= 0) return { ok: false, error: "本文免费，无需解锁" };
    if (Number(art.author_id) === userId) return { ok: false, error: "作者本人无需解锁" };

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 1) 占位判重：唯一键 (article_id, user_id) 挡并发双击
      const [ins] = await conn.query(
        `INSERT IGNORE INTO article_purchases (article_id, user_id, price, author_gain) VALUES (?, ?, 0, 0)`,
        [art.id, userId]
      );
      if (Number((ins as { affectedRows?: number }).affectedRows ?? 0) === 0) {
        await conn.rollback();
        return { ok: true, price: 0, authorGot: 0, balance: -1 }; // 已解锁，幂等
      }
      // 2) 锁行扣款
      const [balRows] = await conn.query(
        `SELECT points_balance FROM users WHERE id = ? FOR UPDATE`,
        [userId]
      );
      const bal = Number((balRows as Record<string, unknown>[])[0]?.points_balance ?? 0);
      if (bal < price) {
        await conn.rollback();
        return { ok: false, error: `积分不足（余额 ${bal}，本次需 ${price}）` };
      }
      await conn.query(`UPDATE users SET points_balance = points_balance - ? WHERE id = ?`, [price, userId]);
      await conn.query(`INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)`, [userId, -price, "付费解锁文章"]);
      // 3) 作者分账 70%
      const authorGot = Math.floor(price * 0.7);
      await conn.query(`UPDATE users SET points_balance = points_balance + ? WHERE id = ?`, [authorGot, Number(art.author_id)]);
      await conn.query(`INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)`, [Number(art.author_id), authorGot, "文章被解锁"]);
      // 4) 补齐购买记录真实金额
      await conn.query(
        `UPDATE article_purchases SET price = ?, author_gain = ? WHERE article_id = ? AND user_id = ?`,
        [price, authorGot, art.id, userId]
      );
      await conn.commit();
      return { ok: true, price, authorGot, balance: bal - price };
    } catch {
      await conn.rollback();
      return { ok: false, error: "解锁失败，请稍后再试" };
    } finally {
      conn.release();
    }
  } catch {
    return { ok: false, error: "解锁失败，请稍后再试" };
  }
}

export type BundleUnlockResult =
  | { ok: true; price: number; authorGot: number; unlocked: number; balance: number; already: boolean }
  | { ok: false; error: string; code: MoneyFailCode };

/**
 * 打包解锁整个专栏：一口价买断「购买时点」的付费篇目快照。
 * 分账：bundle_price 按未解锁篇目均摊（余数给前几篇），每篇 70/30 落 article_purchases，
 * 书房收入看板（listMyUnlockIncome）因此天然兼容打包订单。
 * 已打包购买过 → 幂等返回 already（按快照语义不补新篇）。
 * v15.0：全程单事务原子化——先 INSERT series_purchases 占位（唯一键防并发双花），
 * 再同事务内 FOR UPDATE 扣款 + 分账 + 逐篇落 article_purchases，任一步失败整体回滚。
 */
export async function bundleUnlock(seriesId: number, userId: number): Promise<BundleUnlockResult> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库暂不可用", code: "server" };
  try {
    await ensureSeriesTables(pool);
    await ensurePaidColumns(pool);
    const [sRows] = await pool.query(
      `SELECT id, author_id, bundle_price AS bundlePrice FROM series WHERE id = ? LIMIT 1`,
      [seriesId]
    );
    const s = (sRows as { id: number; author_id: number; bundlePrice: number | null }[])[0];
    if (!s) return { ok: false, error: "专栏不存在", code: "notfound" };
    const bundlePrice = Math.floor(Number(s.bundlePrice ?? 0));
    if (bundlePrice <= 0) return { ok: false, error: "本专栏未开放打包购买", code: "forbidden" };
    if (Number(s.author_id) === userId) return { ok: false, error: "这是你自己的专栏，无需购买", code: "forbidden" };

    // 未解锁的付费篇目（排除已单买过的）
    const [aRows] = await pool.query(
      `SELECT a.id, IFNULL(a.unlock_price,0) AS unlockPrice
         FROM series_items si JOIN articles a ON a.id = si.article_id
        WHERE si.series_id = ? AND a.status = 'published' AND a.review_status = 'approved'
              AND IFNULL(a.unlock_price,0) > 0
              AND NOT EXISTS(SELECT 1 FROM article_purchases p WHERE p.article_id = a.id AND p.user_id = ?)`,
      [seriesId, userId]
    );
    const pending = (aRows as { id: number; unlockPrice: number }[]).map((r) => Number(r.id));
    if (pending.length === 0) {
      return { ok: false, error: "专栏内已无待解锁的付费篇目", code: "forbidden" };
    }

    // 分摊：floor 均摊，余数分给前几篇（保证 sum(shares) === bundlePrice）
    const base = Math.floor(bundlePrice / pending.length);
    let remainder = bundlePrice - base * pending.length;
    const shares = pending.map(() => {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder -= 1;
      return base + extra;
    });
    const authorGot = shares.reduce((sum, sh) => sum + Math.floor(sh * 0.7), 0);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 1) 占位判重：唯一键 (series_id, user_id) 挡并发双击
      const [ins] = await conn.query(
        `INSERT IGNORE INTO series_purchases (series_id, user_id, price, author_gain, item_count) VALUES (?, ?, 0, 0, 0)`,
        [seriesId, userId]
      );
      if (Number((ins as { affectedRows?: number }).affectedRows ?? 0) === 0) {
        await conn.rollback();
        return { ok: true, price: 0, authorGot: 0, unlocked: 0, balance: -1, already: true };
      }
      // 2) 锁行扣款
      const [balRows] = await conn.query(`SELECT points_balance FROM users WHERE id = ? FOR UPDATE`, [userId]);
      const bal = Number((balRows as Record<string, unknown>[])[0]?.points_balance ?? 0);
      if (bal < bundlePrice) {
        await conn.rollback();
        return { ok: false, error: `积分不足（余额 ${bal}，本次需 ${bundlePrice}）`, code: "insufficient" };
      }
      await conn.query(`UPDATE users SET points_balance = points_balance - ? WHERE id = ?`, [bundlePrice, userId]);
      await conn.query(`INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)`, [userId, -bundlePrice, "专栏打包解锁"]);
      // 3) 作者分账
      await conn.query(`UPDATE users SET points_balance = points_balance + ? WHERE id = ?`, [authorGot, Number(s.author_id)]);
      await conn.query(`INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)`, [Number(s.author_id), authorGot, "专栏被打包解锁"]);
      // 4) 逐篇落明细 + 补齐打包单真实金额
      for (let i = 0; i < pending.length; i++) {
        await conn.query(
          `INSERT IGNORE INTO article_purchases (article_id, user_id, price, author_gain) VALUES (?, ?, ?, ?)`,
          [pending[i], userId, shares[i], Math.floor(shares[i] * 0.7)]
        );
      }
      await conn.query(
        `UPDATE series_purchases SET price = ?, author_gain = ?, item_count = ? WHERE series_id = ? AND user_id = ?`,
        [bundlePrice, authorGot, pending.length, seriesId, userId]
      );
      await conn.commit();
      return { ok: true, price: bundlePrice, authorGot, unlocked: pending.length, balance: bal - bundlePrice, already: false };
    } catch {
      await conn.rollback();
      return { ok: false, error: "打包解锁失败，请稍后再试", code: "server" };
    } finally {
      conn.release();
    }
  } catch {
    return { ok: false, error: "打包解锁失败，请稍后再试", code: "server" };
  }
}

/* ======================= 打赏 / 加热（单事务金钱链路） ======================= */

export const TIP_AMOUNTS = [10, 50] as const;
/** 作者分成比例（打赏 90% / 平台 10%） */
const TIP_AUTHOR_SHARE = 0.9;
export const BOOST_COST = 80;

export type MoneyFailCode = "notfound" | "forbidden" | "insufficient" | "server";

export type TipResult =
  | { ok: true; amount: number; authorGot: number; balance: number; toUserId: number }
  | { ok: false; error: string; code: MoneyFailCode };

export type BoostResult =
  | { ok: true; cost: number; balance: number; boostUntil: string | null }
  | { ok: false; error: string; code: MoneyFailCode };

/**
 * 墨水打赏（v17.3 单事务重构）。
 *
 * 修复前：`spendPoints()` 事务提交 → `creditPoints()` 事务提交，两段式。
 * 第二段失败靠补偿事务退分，补偿再失败就**永久丢墨**；两段提交之间进程崩溃
 * 同样无法补偿（没有任何待补偿记录可恢复）。且 `article_tips` 明细用
 * `.catch(()=>{})` 吞掉，会出现「钱动了、流水没落」的对账缺口。
 *
 * 现在对齐 `unlockArticle` 的标准写法：扣款、作者分账、双份流水、明细落库
 * 全在**同一事务**内，任一环节失败整体回滚，不再依赖补偿。
 * 并发安全：`SELECT ... FOR UPDATE` 按 id 升序锁定双方账户行，规避互相打赏时的死锁。
 */
export async function tipArticle(
  slug: string,
  fromUserId: number,
  amount: number
): Promise<TipResult> {
  if (!(TIP_AMOUNTS as readonly number[]).includes(amount)) {
    return { ok: false, error: `打赏档位须为 ${TIP_AMOUNTS.join(" 或 ")} 点墨`, code: "server" };
  }
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库暂不可用", code: "server" };
  try {
    const [rows] = await pool.query(
      "SELECT id, author_id FROM articles WHERE slug = ? AND status = 'published' LIMIT 1",
      [slug]
    );
    const art = (rows as { id: number; author_id: number }[])[0];
    if (!art) return { ok: false, error: "文章不存在", code: "notfound" };
    const toUserId = Number(art.author_id);
    if (toUserId === fromUserId) return { ok: false, error: "不能给自己的文章打赏", code: "forbidden" };

    const authorGot = Math.floor(amount * TIP_AUTHOR_SHARE);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 1) 双方账户按 id 升序加锁（避免互相打赏造成交叉等待死锁）
      const [lockRows] = await conn.query(
        `SELECT id, points_balance FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE`,
        [fromUserId, toUserId]
      );
      const bal = Number(
        (lockRows as Record<string, unknown>[]).find((r) => Number(r.id) === fromUserId)
          ?.points_balance ?? 0
      );
      if (bal < amount) {
        await conn.rollback();
        return { ok: false, error: `积分不足（余额 ${bal}，本次需 ${amount}）`, code: "insufficient" };
      }
      // 2) 读者扣款 + 流水
      await conn.query("UPDATE users SET points_balance = points_balance - ? WHERE id = ?", [
        amount,
        fromUserId,
      ]);
      await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
        fromUserId,
        -amount,
        "墨水打赏",
      ]);
      // 3) 作者分账 + 流水
      await conn.query("UPDATE users SET points_balance = points_balance + ? WHERE id = ?", [
        authorGot,
        toUserId,
      ]);
      await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
        toUserId,
        authorGot,
        "收到打赏",
      ]);
      // 4) 明细落库（同事务，不再吞异常）
      await conn.query(
        "INSERT INTO article_tips (article_id, from_user, to_user, amount) VALUES (?, ?, ?, ?)",
        [art.id, fromUserId, toUserId, amount]
      );
      await conn.commit();
      return { ok: true, amount, authorGot, balance: bal - amount, toUserId };
    } catch {
      await conn.rollback();
      return { ok: false, error: "打赏失败，请稍后再试", code: "server" };
    } finally {
      conn.release();
    }
  } catch {
    return { ok: false, error: "打赏失败，请稍后再试", code: "server" };
  }
}

/**
 * 文章加热（v17.3 单事务重构）。
 *
 * 修复前：`spendPoints()` 提交后写 `article_boosts`；`affectedRows !== 1` 有退墨分支，
 * 但**抛异常时没有**——`pool.query` 一旦抛错（表缺失、连接中断、超时、自引用子查询报错），
 * 控制流直接跳到最外层 catch 返回 500，那 80 点墨**既不加热也不退还**，静默蒸发。
 *
 * 现在：锁行扣款、流水、加热记录全在同一事务内，异常一律回滚，钱与货要么同时成立要么都不动。
 */
export async function boostArticle(slug: string, userId: number): Promise<BoostResult> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库暂不可用", code: "server" };
  try {
    const [rows] = await pool.query(
      "SELECT id, author_id FROM articles WHERE slug = ? AND status = 'published' LIMIT 1",
      [slug]
    );
    const art = (rows as { id: number; author_id: number }[])[0];
    if (!art) return { ok: false, error: "文章不存在", code: "notfound" };
    if (Number(art.author_id) !== userId) {
      return { ok: false, error: "只能加热自己的文章", code: "forbidden" };
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 1) 锁行扣款 + 流水
      const [balRows] = await conn.query(
        "SELECT points_balance FROM users WHERE id = ? FOR UPDATE",
        [userId]
      );
      const bal = Number((balRows as Record<string, unknown>[])[0]?.points_balance ?? 0);
      if (bal < BOOST_COST) {
        await conn.rollback();
        return {
          ok: false,
          error: `积分不足（余额 ${bal}，本次需 ${BOOST_COST}）`,
          code: "insufficient",
        };
      }
      await conn.query("UPDATE users SET points_balance = points_balance - ? WHERE id = ?", [
        BOOST_COST,
        userId,
      ]);
      await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
        userId,
        -BOOST_COST,
        "文章加热·24h",
      ]);
      // 2) 写入加热记录：叠加规则「新截止 = MAX(现在, 现有未过期截止) + 24h」
      const [ins] = await conn.query(
        `INSERT INTO article_boosts (article_id, user_id, boost_until)
         VALUES (?, ?, DATE_ADD(GREATEST(NOW(), IFNULL(
                    (SELECT MAX(b.boost_until) FROM article_boosts b
                      WHERE b.article_id = ? AND b.boost_until > NOW()), NOW())), INTERVAL 24 HOUR))`,
        [art.id, userId, art.id]
      );
      const boostId = Number((ins as { insertId?: number }).insertId ?? 0);
      if (!boostId) {
        await conn.rollback();
        return { ok: false, error: "加热失败，请稍后再试", code: "server" };
      }
      const [untilRows] = await conn.query(
        "SELECT boost_until AS until_ FROM article_boosts WHERE id = ?",
        [boostId]
      );
      const until = (untilRows as { until_: Date | string | null }[])[0]?.until_ ?? null;
      await conn.commit();
      return {
        ok: true,
        cost: BOOST_COST,
        balance: bal - BOOST_COST,
        boostUntil:
          until instanceof Date ? until.toISOString() : until ? new Date(String(until)).toISOString() : null,
      };
    } catch {
      await conn.rollback();
      return { ok: false, error: "加热失败，请稍后再试", code: "server" };
    } finally {
      conn.release();
    }
  } catch {
    return { ok: false, error: "加热失败，请稍后再试", code: "server" };
  }
}

/* ======================= 付费转化漏斗（书房看板） ======================= */

export type FunnelRow = {
  slug: string;
  title: string;
  /** 累计阅读（文章页 PV） */
  views: number;
  /** 付费墙到达次数（被墙挡住的阅读） */
  paywallViews: number;
  /** 解锁人次（含打包分摊） */
  unlocks: number;
  /** 解锁收入（滴，作者分成后） */
  revenue: number;
};

/** 记一次付费墙到达（仅被墙文章触发；失败静默——埋点不阻塞阅读） */
export async function recordPaywallView(slug: string): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await ensurePaidColumns(pool);
    await pool.query(
      `UPDATE articles SET paywall_views = paywall_views + 1
        WHERE slug = ? AND status = 'published' AND IFNULL(unlock_price,0) > 0 LIMIT 1`,
      [slug]
    );
  } catch {
    /* 埋点失败不影响主流程 */
  }
}

/** 作者付费转化漏斗：阅读 → 付费墙 → 解锁（含收入），按解锁数降序 */
export async function listMyFunnel(authorId: number): Promise<FunnelRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  try {
    await ensurePaidColumns(pool);
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

/* ======================= 作者解锁收入（书房看板） ======================= */

export type UnlockIncome = {
  /** 累计到手墨水（70% 分成部分） */
  total: number;
  /** 累计解锁人次 */
  sales: number;
  /** 按文章汇总（按收入降序） */
  byArticle: { slug: string; title: string; sales: number; earned: number; price: number }[];
};

/** 我的名下文章被解锁的收入汇总（含价格已改的历史成交，按成交价算） */
export async function listMyUnlockIncome(authorId: number): Promise<UnlockIncome> {
  const empty: UnlockIncome = { total: 0, sales: 0, byArticle: [] };
  const pool = await getPool();
  if (!pool || !authorId) return empty;
  try {
    await ensurePaidColumns(pool);
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
