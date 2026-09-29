// 页面取数层：配了 JAVA_BASE 就只有一条路——问 Java；没配就只用内置演示数据。
//
// P7e′ 之前这里每个读函数开头都有一句 `if (viaJava("x"))` 的分流，Node 侧还留着一份 SQL 实现；
// 那份实现后来集中到 lib/data-legacy.ts，随 app/api/** 一起在 P7f-2 删除。于是
// "同一个页面在两栈各算一遍"这件事从可选变成不可能：页面级只剩"渲染必须长成什么样"的
// 断言可写（scripts/page-check.mjs，闸门 4），README 的闸门 4 一节写了为什么这不是退步。
//
// 分流删掉之后剩下的这个二选一必须钉死方向：
//   · JAVA_BASE 没配 → 演示数据。这是"clone 下来先跑起来看界面"的产品承诺，不是故障。
//   · JAVA_BASE 配了但调用失败 → **抛出**，页面 500。绝不静默回落。
// 回落会把"Java 挂了"伪装成"站点正常"，而 listArticles 的 SQL 路径当年 catch 降级成 demo
// 正是这个坑（页面 200、数据是假的、日志里什么都没有）。
import { demoArticles, demoComments, type DemoArticle, type DemoComment } from "./demo-data";
import {
  javaReady,
  remoteAuthorArticleStats, remoteFollowStats, remoteGetArticle, remoteGetAuthor, remoteIsBookmarked,
  remoteIsFollowing, remoteListArticleTips, remoteListArticles, remoteListAuthorArticles, remoteListByTag,
  remoteListComments, remoteListSeries, remoteMyArticles, remoteMyBookmarks, remoteMyComments,
  remoteMyFollowers, remoteMyFollowing, remoteMyFunnel, remoteMyHistory, remoteMyLikes, remoteMySeries,
  remoteMyUnlockIncome, remoteRandomSlug, remoteSearchArticles, remoteSeriesDetail, remoteSeriesNav,
  remoteAchievements, remoteAdminActions, remoteAdminArticles, remoteAdminComments,
  remoteAdminInsights, remoteAdminOrders, remoteAdminReports, remoteAdminReview,
  remoteAdminUsers, remoteBadgeRewardClaimed, remoteFollowingFeed, remotePlatformStats,
  remoteSeriesTitleSuggestions, remoteTopAuthors, remoteWeeklyStats,
} from "./java-source";

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
export function dateOnly(v: unknown): string {
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

/* ---------- 印章头像列（v17.4 印章工坊）：users.avatar_tone / avatar_shape，建表归 db/schema.sql ---------- */

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

export function demoToRow(a: DemoArticle): ArticleRow {
  return { ...a };
}

export async function listArticles(): Promise<ArticleRow[]>  {
  if (!javaReady()) return demoArticles.map(demoToRow).sort((a, b) => gravity(b) - gravity(a));
  return remoteListArticles();
}

/* ---------- 标签聚合页：/tag/[tag] ---------- */

export async function listByTag(tag: string, limit = 50): Promise<ArticleRow[]>  {
  if (!javaReady()) return [];
  return remoteListByTag(tag, limit);
}

/** 漫游记：随机取一篇公开且过审文章的 slug；无候选或库不可用时返回 null，页面据此回首页。
 *  原先这条 SQL 直接写在 app/random/page.tsx 里，P3 收进数据层才能整体分流。 */
export async function randomArticleSlug(exclude = ""): Promise<string | null>  {
  if (!javaReady()) return null;
  return remoteRandomSlug(exclude);
}

// 演示模式下的重力排序（与 DB SQL 同一公式）
export function gravity(a: { readCount: number; commentCount: number; agentQaCount: number; publishedAt: string }): number {
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
): Promise<ArticleRow | null>  {
  if (!javaReady()) return (await listArticles()).find((a) => a.slug === slug) ?? null;
  return remoteGetArticle(slug);
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

export async function listArticleTips(slug: string, limit = 6): Promise<ArticleTipRow[]>  {
  if (!javaReady()) return [];
  return remoteListArticleTips(slug, limit);
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
export async function listMyArticles(userId: number): Promise<{ rows: MyArticleRow[]; stats: MyStats }>  {
  if (!javaReady())
    return { rows: [], stats: { published: 0, totalReads: 0, totalLikes: 0, tipIncome: 0, totalQa: 0, drafts: 0 } };
  return remoteMyArticles();
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

export function demoToCommentRows(slug: string): CommentRow[] {
  return (demoComments[slug] ?? []).map((c) => ({ ...c, likes: 0, viewerLiked: false }));
}export async function listComments(slug: string, viewerId?: number | null): Promise<CommentRow[]>  {
  if (!javaReady()) return demoToCommentRows(slug);
  return remoteListComments(slug);
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
  if (!javaReady()) return [];
  return remoteAdminArticles();
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
  if (!javaReady()) return [];
  return remoteAdminReview();
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
  if (!javaReady()) return [];
  return remoteAdminUsers(q);
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
  if (!javaReady()) return [];
  return remoteAdminReports(status);
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
  if (!javaReady()) return [];
  return remoteAdminActions(limit);
}

/** 审核操作：通过 / 驳回（驳回需带原因，会通知作者） */
/** 用户管理操作：封禁/解封/加分/扣分（封禁即时生效——getCurrentUser 拒绝 banned 用户） */
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
  if (!javaReady()) return [];
  return remoteAdminOrders();
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
  if (!javaReady()) return [];
  return remoteAdminComments();
}

/** 删除评论（含一级回复），并回扣文章评论计数 */
/** 运营改价：单篇解锁价 / 限时折扣（0 = 关闭付费墙） */
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
/** 举报处理：删除内容 / 保留内容仅忽略 / 直接关闭 */
/** 管理操作审计日志（运营台所有敏感动作调用） */
/* ---------- 首页：平台数据横幅 ---------- */

export type PlatformStats = { articles: number; authors: number; qaTotal: number; tipsTotal: number };

/** 首页数据横幅。演示模式回四个 0，与"没有池子"时旧行为一字不差（同 listWeekly 那条注释的口径）。 */
export async function platformStats(): Promise<PlatformStats> {
  if (!javaReady()) return { articles: 0, authors: 0, qaTotal: 0, tipsTotal: 0 };
  return remotePlatformStats();
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
  if (!javaReady()) return [];
  return remoteTopAuthors(limit);
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
): Promise<SearchResultRow[]>  {
  if (!javaReady()) return [];
  return remoteSearchArticles(q, limit, viewerId);
}

/* ---------- 关注系统：作者与读者建立长期连接（留存核心） ---------- */

export type FollowStats = { followers: number; following: number };

/** 关注列表里的一个人（粉丝/关注两个方向共用同一形状）。 */
export type FollowPeer = {
  id: number;
  nickname: string;
  avatarText: string;
  avatarTone: string;
  avatarShape: string;
  bio: string;
  articles: number;
};

/** 足迹里的一篇（点赞/收藏/阅读历史共用，各自再补自己的时间字段）。 */
export type FootprintArticle = { slug: string; title: string; author: string; readCount: number };
export type BookmarkRow = FootprintArticle & { savedAt: string };
export type HistoryRow = FootprintArticle & { readAt: string; times: number };
export type MyCommentRow = {
  id: number;
  content: string;
  createdAt: string;
  articleSlug: string;
  articleTitle: string;
};

/** 每周墨报的本期计数。周报的其余字段是对已分流列表的 JS 组装，不在这份契约里。 */
export type WeeklyStats = {
  newArticles: number;
  newUsers: number;
  newComments: number;
  newSeries: number;
  tipCount: number;
  tipInk: number;
};

/** 某作者的粉丝/关注计数 */
export async function followStats(userId: number): Promise<FollowStats>  {
  if (!javaReady()) return { followers: 0, following: 0 };
  return remoteFollowStats(userId);
}

/** viewer 是否已关注 target */
export async function isFollowing(followerId: number | null, followeeId: number): Promise<boolean>  {
  if (!javaReady()) return false;
  return remoteIsFollowing(followerId, followeeId);
}

/** 关注/取关（toggle）。返回关注后的最新状态 */
/** 关注我的人（个人中心·粉丝列表） */
export async function listMyFollowers(userId: number, limit = 50): Promise<FollowPeer[]>  {
  if (!javaReady()) return [];
  return remoteMyFollowers(limit);
}

/** 我关注的人（个人中心足迹） */
export async function listMyFollowing(userId: number, limit = 50): Promise<FollowPeer[]>  {
  if (!javaReady()) return [];
  return remoteMyFollowing(limit);
}

/** 我点赞过的文章（个人中心足迹） */
export async function listMyLikes(userId: number, limit = 30): Promise<FootprintArticle[]>  {
  if (!javaReady()) return [];
  return remoteMyLikes(limit);
}

/** 我发表过的评论（个人中心足迹，带文章上下文） */
export async function listMyComments(userId: number, limit = 30): Promise<MyCommentRow[]>  {
  if (!javaReady()) return [];
  return remoteMyComments(limit);
}/** viewer 是否收藏了某篇 */
export async function isBookmarked(userId: number | null, slug: string): Promise<boolean>  {
  if (!javaReady()) return false;
  return remoteIsBookmarked(userId, slug);
}

/** 我的收藏列表（个人中心足迹） */
export async function listMyBookmarks(userId: number, limit = 50): Promise<BookmarkRow[]>  {
  if (!javaReady()) return [];
  return remoteMyBookmarks(limit);
}

/* ---------- 阅读历史「最近读过」（read_history 表由 db/schema.sql 建） ---------- */

/** 记录一次阅读（同人同文去重，累计次数 + 刷新最近时间） */
/** 我的阅读足迹（个人中心「最近读过」） */
export async function listMyHistory(userId: number, limit = 30): Promise<HistoryRow[]>  {
  if (!javaReady()) return [];
  return remoteMyHistory(limit);
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

export async function authorArticleStats(authorId: number, limit = 50): Promise<AuthorArticleStat[]>  {
  if (!javaReady()) return [];
  return remoteAuthorArticleStats(authorId, limit);
}

/* ---------- 热榜 /hot：按时间窗排序热度 ---------- */

export type HotRange = "day" | "week" | "all";

/** 热度 = 阅读 + 点赞×5 + 评论×5 + 分身问答×10 + 打赏×3，仅统计时间窗内发表的文章 */
export async function listHot(range: HotRange = "day", limit = 20): Promise<ArticleRow[]> {
  return rankHot(await listArticles(), range, limit);
}

/** 热榜的纯计算部分。页面侧（Java 取数）与 lib/data-legacy.ts（Node SQL）共用这一个口径，
 *  否则"同一篇稿子排在第几"会有两套答案。 */
export function rankHot(all: ArticleRow[], range: HotRange = "day", limit = 20): ArticleRow[] {
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

export async function getAuthor(id: number): Promise<AuthorProfile | null>  {
  if (!javaReady()) return null;
  return remoteGetAuthor(id);
}

/** 某作者的公开文章（仅 approved），按发布时间倒序 */
export async function listAuthorArticles(authorId: number, limit = 30): Promise<ArticleRow[]>  {
  if (!javaReady()) return [];
  return remoteListAuthorArticles(authorId, limit);
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

/**
 * 首页关注动态流。签名仍收 userId，但 Java 侧的 `/api/me/following-feed` 认的是**请求 cookie 里的
 * 那个人**——现在四个调用点传的都是当前会话自己（`user.id`），所以等价；
 * 哪天要显示别人的动态流，就得在 Java 侧新开一条按 id 取的路由，不能悄悄复用这一条。
 */
export async function listFollowingFeed(userId: number, limit = 8): Promise<FeedItem[]> {
  if (!javaReady()) return [];
  return remoteFollowingFeed(limit);
}

/* ============================================================
   成就徽章墙：14 枚的阈值表与计数都在 Java 的 BadgeService（P7f-1d 迁走）。
   这里只剩类型定义。首页与书房的读同批迁走，lib/data.ts 里剩下的进程内 SQL
   全部属于运营台那 8 条（闸门 18 的登记表）。
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
  if (!javaReady()) return [];
  return remoteAchievements();
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

/** 这两个常量现在只服务 Node 侧那条 POST 领取路由；P7f-2 删路由时一起消失，Java 侧另有同名常量。 */
export const BADGE_REWARD_REASON = "集齐徽章奖励";
export const BADGE_REWARD_AMOUNT = 100;

export async function badgeRewardClaimed(userId: number): Promise<boolean> {
  if (!javaReady()) return false;
  return remoteBadgeRewardClaimed();
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
  // 演示模式仍然回"零值 + 完整 14 天轴"：这是没有池子时旧行为的一字复制，
  // 轴在、图就画得出来，只是全贴着零——"图是空的"和"取数挂了"在运营眼里是两件事。
  if (!javaReady()) return zeroInsights();
  return remoteAdminInsights();
}

function zeroInsights(): AdminInsights {
  return {
    days: lastNDays(DAYS_WINDOW).map((x) => ({ ...x, articles: 0, users: 0, comments: 0 })),
    ink: { tipCount: 0, tipTotal: 0, authorGot: 0, topupCount: 0, topupTotal: 0, qaCount: 0 },
    topArticles: [],
    tags: [],
    funnel: { paidArticles: 0, paywallViews: 0, unlocks: 0, bundles: 0, revenue: 0 },
  };
}

/* ============================================================
   专栏合集（series）：合集架 / 落地页 / 书房管理 / 文章页导航
   （series / series_items / series_purchases 三张表由 db/schema.sql 建）
   ============================================================ */

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
export async function listSeries(limit = 60, authorId?: number): Promise<SeriesCard[]>  {
  if (!javaReady()) return [];
  return remoteListSeries(limit, authorId);
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
export async function getSeriesDetail(id: number, viewer?: { id?: number | null }): Promise<SeriesDetail | null>  {
  if (!javaReady()) return null;
  return remoteSeriesDetail(id);
}

export type MySeries = {
  id: number;
  title: string;
  description: string;
  items: { slug: string; title: string }[];
};

/** 书房管理器：我的专栏 + 各自篇目（含未发布，便于编辑） */
export async function listMySeries(authorId: number): Promise<MySeries[]>  {
  if (!javaReady()) return [];
  return remoteMySeries();
}

/** 专栏题名建议：Java 侧聚合作者已过审文章的标签（≥2 篇才有成柜潜力），按热度取前三 */
export type SeriesTitleSuggestion = { title: string; hint: string };

export async function suggestSeriesTitles(authorId: number): Promise<SeriesTitleSuggestion[]> {
  if (!javaReady()) return [];
  return remoteSeriesTitleSuggestions();
}

/** 新建专栏，返回 id */
/** 更新专栏元信息（仅作者本人） */
/** 删除专栏（仅作者本人；条目级联删除） */
/** 重设专栏篇目（整体替换）：仅收本人已发布且过审的文章，按数组顺序定 position */
export type ArticleSeriesNav = {
  id: number;
  title: string;
  position: number;
  total: number;
  prev: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
};

/** 文章页专栏导航：文章所属专栏 + 上/下篇（取 position 最小的所属专栏） */
export async function getArticleSeriesNav(slug: string): Promise<ArticleSeriesNav | null>  {
  if (!javaReady()) return null;
  return remoteSeriesNav(slug);
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

export function weeklyFmt(d: Date): string {
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
  // 只把"本期计数"交给 Java：期号、近 6 周分桶、热榜与最新刊都是对已分流列表的 JS 组装，
  // 周界算法留在唯一一侧，两栈才不会因为"本周从哪天开始"差出一天。
  if (!javaReady()) return base; // 演示模式：计数保持 0，与"没有池子"时的旧行为一字不差
  return { ...base, ...(await remoteWeeklyStats(fromStr)) };
}
export type UnlockResult =
  | { ok: true; price: number; authorGot: number; balance: number }
  | { ok: false; error: string };

/** 解锁付费文章：读者付 unlock_price，作者得 70%，平台 30%（购过幂等返回成功）
 *  v15.0：全程单事务原子化——先 INSERT 占位（唯一键判重防并发双花），
 *  再 FOR UPDATE 扣款 + 分账 + 流水，任一步失败整体回滚。 */
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
/**
 * 文章加热（v17.3 单事务重构）。
 *
 * 修复前：`spendPoints()` 提交后写 `article_boosts`；`affectedRows !== 1` 有退墨分支，
 * 但**抛异常时没有**——`pool.query` 一旦抛错（表缺失、连接中断、超时、自引用子查询报错），
 * 控制流直接跳到最外层 catch 返回 500，那 80 点墨**既不加热也不退还**，静默蒸发。
 *
 * 现在：锁行扣款、流水、加热记录全在同一事务内，异常一律回滚，钱与货要么同时成立要么都不动。
 */
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
/** 作者付费转化漏斗：阅读 → 付费墙 → 解锁（含收入），按解锁数降序 */
export async function listMyFunnel(authorId: number): Promise<FunnelRow[]>  {
  if (!javaReady()) return [];
  return remoteMyFunnel();
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
export async function listMyUnlockIncome(authorId: number): Promise<UnlockIncome>  {
  if (!javaReady()) return { total: 0, sales: 0, byArticle: [] };
  return remoteMyUnlockIncome();
}
