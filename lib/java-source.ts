// Java 后端数据源客户端。
//
// 为什么需要它：28 个页面里有 27 个是 Server Component，原本直接 import lib/data.ts 在进程内打 MySQL。
// 后端换到 Java 后，这些页面的数据来源要改，但页面本身的 UI 与取数语义不想动，
// 所以取数层每个读函数都收成一句"问 Java"。双轨期那个逐函数开关（DATA_VIA_JAVA）已经随
// Node 侧读 SQL 一起退场（见 lib/data.ts 头部），现在只剩 javaReady() 这一个开关。
//
// 三条硬规矩：
// 1) 必须转发 ink_session Cookie。Java 侧自己解析会话来决定付费墙与审核可见性，
//    不转发就会把已登录读者当游客，导致未购正文被当成有权读。
// 2) 必须 no-store。RSC 默认可能缓存取数结果，换栈期两侧行为要在每次渲染里现取现比。
// 3) 失败必须抛出，绝不静默回落。回落会把"Java 挂了"伪装成"站点正常"，
//    而 listArticles 原本那句 catch-降级成-demo 正是这个坑。
import { cache } from "react";
import { cookies } from "next/headers";
import type {
  ArticleRow, ArticleSeriesNav, ArticleTipRow, AuthorArticleStat, AuthorProfile, AuthorRankRow, BookmarkRow,
  CommentRow, Achievement, AdminActionLogRow, AdminArticleRow, AdminCommentRow, AdminInsights, AdminOrderRow,
  AdminUserRow, FeedItem, FollowPeer, FollowStats, FootprintArticle, FunnelRow, HistoryRow,
  MyArticleRow, MyCommentRow, MySeries, MyStats, PlatformStats, ReportRow, ReviewRow, SearchResultRow,
  SeriesCard, SeriesDetail, SeriesTitleSuggestion, UnlockIncome, WeeklyStats,
} from "./data";
import type { SessionRow, SessionUser } from "./auth";

const TIMEOUT_MS = 8_000;

/**
 * 有没有配 Java 后端。这是页面取数唯一的一个开关：
 * 配了 → 只问 Java（失败就抛，页面 500）；没配 → 演示模式，只用 lib/demo-data.ts。
 * 以前的 `DATA_VIA_JAVA` 逐函数开关已经随 P7e′ 退役：Node 侧那份读 SQL 不再是页面的一条退路。
 */
export const javaReady = (): boolean => Boolean((process.env.JAVA_BASE ?? "").trim());

function javaBase(): string {
  const base = (process.env.JAVA_BASE ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("JAVA_BASE 未配置，页面取数无法问到 Java");
  return base;
}

/**
 * 返回可直接用作 Cookie 请求头的字符串（`ink_session=<value>`），游客为空串。
 *
 * 注意 cookies().get() 给的是**去掉名字后的值**，直接当请求头发出去是一条畸形 Cookie，
 * Java 侧解不出会话就把已登录读者当游客——付费墙会对作者本人和已购买者都判"未解锁"，
 * 而页面仍然 200，只在正文处悄悄截断，极难从渲染结果反推。
 */
async function forwardCookie(): Promise<string> {
  try {
    const value = (await cookies()).get("ink_session")?.value ?? "";
    return value ? `ink_session=${value}` : "";
  } catch {
    // 非请求上下文（静态生成、脚本、sitemap）拿不到 Cookie：按游客身份取公开数据。
    return "";
  }
}

async function ask<T>(path: string): Promise<T> {
  const cookie = await forwardCookie();
  const res = await fetch(`${javaBase()}${path}`, {
    headers: { cookie, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e: unknown) => {
    throw new Error(`Java 数据源不可达 ${path}：${e instanceof Error ? e.message : String(e)}`);
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Java 数据源返回非 JSON（${res.status}）${path}：${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const err = (json as { error?: string })?.error ?? text.slice(0, 160);
    throw new Error(`Java 数据源 ${res.status} ${path}：${err}`);
  }
  return json as T;
}

export async function remoteListArticles(): Promise<ArticleRow[]> {
  const body = await ask<{ articles: ArticleRow[] }>("/api/articles");
  return body.articles;
}

/**
 * Java 的详情接口在服务端一次判清付费墙：有权读回全文、无权读回 SQL 层截断的 6 行。
 * 因此 Node 版"先取截断再取全文"的第二次调用在这里天然合并成同一结果——
 * includeMd 对 Java 路径不再有意义，两个调用返回同一个对象（同一次渲染内由 cache() 合流）。
 */
export const remoteGetArticle = cache(async (slug: string): Promise<ArticleRow | null> => {
  try {
    const body = await ask<{ article: ArticleRow }>(`/api/articles/${encodeURIComponent(slug)}`);
    return body.article;
  } catch (e) {
    // 404 是正常语义（文章不存在 / 对当前身份不可见），页面据此走 notFound()。
    if (e instanceof Error && e.message.includes("404")) return null;
    throw e;
  }
});

/* ---------- 文章页读侧 ----------
 * Java 端一律从转发的 Cookie 里取当前身份，而 Node 侧这些函数的签名是显式传 viewerId/authorId。
 * 两条路同源（页面用的就是同一个会话解析的结果），所以不需要额外校验。
 */

/** 关注关系一次取全（粉丝数/关注数/我是否已关注）；同一渲染内合流，避免三次往返。 */
export const remoteRelation = cache(async (userId: number): Promise<FollowStats & { viewerFollows: boolean }> =>
  ask<FollowStats & { viewerFollows: boolean }>(`/api/users/${userId}/relation`));

export async function remoteFollowStats(userId: number): Promise<FollowStats> {
  const r = await remoteRelation(userId);
  return { followers: r.followers, following: r.following };
}

export async function remoteIsFollowing(followerId: number | null, followeeId: number): Promise<boolean> {
  if (!followerId) return false;
  const r = await remoteRelation(followeeId);
  return r.viewerFollows;
}

export async function remoteListComments(slug: string): Promise<CommentRow[]> {
  const body = await ask<{ comments: CommentRow[] }>(`/api/articles/${encodeURIComponent(slug)}/comments`);
  return body.comments;
}

export async function remoteListArticleTips(slug: string, limit: number): Promise<ArticleTipRow[]> {
  const body = await ask<{ tips: ArticleTipRow[] }>(
    `/api/articles/${encodeURIComponent(slug)}/tips?limit=${limit}`);
  return body.tips;
}

export async function remoteIsBookmarked(userId: number | null, slug: string): Promise<boolean> {
  if (!userId) return false;
  const body = await ask<{ saved: boolean }>(`/api/articles/${encodeURIComponent(slug)}/saved`);
  return Boolean(body.saved);
}

export const remoteSeriesNav = cache(async (slug: string): Promise<ArticleSeriesNav | null> => {
  const body = await ask<{ nav: ArticleSeriesNav | null }>(
    `/api/articles/${encodeURIComponent(slug)}/series-nav`);
  return body.nav ?? null;
});

export async function remoteMySeries(): Promise<MySeries[]> {
  const body = await ask<{ ok?: boolean; series: MySeries[] }>("/api/series/mine");
  return body.series;
}

/** 各 Java 端点用不同的包壳键名（与 Node 同名函数的返回结构对齐），这里统一取数组。 */
async function askList<T>(path: string, key: string): Promise<T[]> {
  const body = await ask<Record<string, T[]>>(path);
  return body?.[key] ?? [];
}

/* ---------- 内容面：搜索 / 话题 / 作者 / 专栏 / 周报 / 漫游记 ---------- */

/** 关键词不足 2 字时 Node 直接回空数组，Java 侧同一路由对 HTTP 调用方回 400——分流前先在本地判掉。 */
export async function remoteSearchArticles(
  q: string, limit: number, viewerId?: number | null
): Promise<SearchResultRow[]> {
  const kw = q.trim().slice(0, 60);
  if (kw.length < 2) return [];
  void viewerId; // 身份由转发的 Cookie 决定，Java 不再接收显式 viewerId
  return askList<SearchResultRow>(
    `/api/search?q=${encodeURIComponent(kw)}&limit=${limit}`, "results");
}

export async function remoteListByTag(tag: string, limit: number): Promise<ArticleRow[]> {
  return askList<ArticleRow>(
    `/api/tags/${encodeURIComponent(tag)}/articles?limit=${limit}`, "articles");
}

export const remoteGetAuthor = cache(async (id: number): Promise<AuthorProfile | null> => {
  if (!Number.isInteger(id) || id <= 0) return null;
  const body = await ask<{ author: AuthorProfile | null }>(`/api/authors/${id}`);
  return body.author ?? null;
});

export async function remoteListAuthorArticles(
  authorId: number, limit: number
): Promise<ArticleRow[]> {
  return askList<ArticleRow>(`/api/authors/${authorId}/articles?limit=${limit}`, "articles");
}

export async function remoteListSeries(limit: number, authorId?: number): Promise<SeriesCard[]> {
  const who = authorId ? `&author=${authorId}` : "";
  return askList<SeriesCard>(`/api/series?limit=${limit}${who}`, "series");
}

/**
 * 专栏落地页。Java 从 Cookie 判定 viewer，因此同一请求上下文里 generateMetadata 的
 * "游客视角"调用与页面的"读者视角"调用会拿到同一份数据——元信息只用到标题/简介/篇数，
 * 三者与 viewer 无关，所以合并是安全的（Node 侧那两次调用本来就同属一次请求）。
 */
export const remoteSeriesDetail = cache(async (id: number): Promise<SeriesDetail | null> => {
  const body = await ask<{ detail: SeriesDetail | null }>(`/api/series/${id}`);
  return body.detail ?? null;
});

export async function remoteWeeklyStats(from: string): Promise<WeeklyStats> {
  return ask<WeeklyStats>(`/api/weekly/stats?from=${encodeURIComponent(from)}`);
}

export async function remoteRandomSlug(exclude: string): Promise<string | null> {
  const body = await ask<{ slug: string | null }>(
    `/api/random?exclude=${encodeURIComponent(exclude.trim())}`);
  return body.slug ?? null;
}

/* ---------- 个人中心与创作台（身份只来自转发的 Cookie，不传 userId） ---------- */

export async function remoteMyFollowing(limit = 50): Promise<FollowPeer[]> {
  return askList<FollowPeer>(`/api/me/following?limit=${limit}`, "following");
}

export async function remoteMyFollowers(limit = 50): Promise<FollowPeer[]> {
  return askList<FollowPeer>(`/api/me/followers?limit=${limit}`, "followers");
}

export async function remoteMyLikes(limit = 30): Promise<FootprintArticle[]> {
  return askList<FootprintArticle>(`/api/me/likes?limit=${limit}`, "likes");
}

export async function remoteMyComments(limit = 30): Promise<MyCommentRow[]> {
  return askList<MyCommentRow>(`/api/me/comments?limit=${limit}`, "comments");
}

export async function remoteMyBookmarks(limit = 50): Promise<BookmarkRow[]> {
  return askList<BookmarkRow>(`/api/me/bookmarks?limit=${limit}`, "bookmarks");
}

export async function remoteMyHistory(limit = 30): Promise<HistoryRow[]> {
  return askList<HistoryRow>(`/api/me/history?limit=${limit}`, "history");
}

export async function remoteMyArticles(): Promise<{ rows: MyArticleRow[]; stats: MyStats }> {
  const body = await ask<{ rows: MyArticleRow[]; stats: MyStats }>("/api/me/articles");
  return { rows: body.rows ?? [], stats: body.stats };
}

export async function remoteAuthorArticleStats(authorId: number, limit: number): Promise<AuthorArticleStat[]> {
  void authorId; // 同上：作者身份来自 Cookie
  return askList<AuthorArticleStat>(`/api/me/author-stats?limit=${limit}`, "stats");
}

export async function remoteMyFunnel(): Promise<FunnelRow[]> {
  return askList<FunnelRow>("/api/me/funnel", "rows");
}

export async function remoteMyUnlockIncome(): Promise<UnlockIncome> {
  const body = await ask<{ income: UnlockIncome }>("/api/me/unlock-income");
  return body.income ?? { total: 0, sales: 0, byArticle: [] };
}

/* ---------- 首页与个人中心的"没有 HTTP 前身"的读（P7f-1d 补） ----------
 * 这六条原本只是 Next 进程里的函数调用，从来没有对应的 Node 路由，所以：
 *   · 没有对岸可以差分——正确性由 scripts/pagereads-check.mjs 回库重算再比对此处守住；
 *   · 端点的键名/形状由 lib/data.ts 的返回类型单方面决定，改任一侧都要同步另一侧。
 */

/** 首页数据横幅的四个全站计数。身份无关，游客也要能看到，所以不带 Cookie 也应 200。 */
export async function remotePlatformStats(): Promise<PlatformStats> {
  return ask<PlatformStats>("/api/platform/stats");
}

export async function remoteTopAuthors(limit: number): Promise<AuthorRankRow[]> {
  return askList<AuthorRankRow>(`/api/platform/top-authors?limit=${limit}`, "authors");
}

/** 关注动态流：Node 签名收 userId，Java 从转发的 Cookie 里认人（同 remoteMyFunnel 一套）。 */
export async function remoteFollowingFeed(limit: number): Promise<FeedItem[]> {
  return askList<FeedItem>(`/api/me/following-feed?limit=${limit}`, "items");
}

export async function remoteAchievements(): Promise<Achievement[]> {
  return askList<Achievement>("/api/me/achievements", "achievements");
}

export async function remoteBadgeRewardClaimed(): Promise<boolean> {
  const body = await ask<{ claimed: boolean }>("/api/me/badge-reward");
  return Boolean(body.claimed);
}

export async function remoteSeriesTitleSuggestions(): Promise<SeriesTitleSuggestion[]> {
  return askList<SeriesTitleSuggestion>("/api/me/series-title-suggestions", "suggestions");
}

/* ---------- 运营台八张表的读（P7f-1e 补） ----------
 * 同样是"没有 HTTP 前身"的一族：运营台是 Server Component 直调 lib/data.ts，
 * /api/admin/* 在 Node 侧只有 POST。八条 GET 全部过 Java 的运营门禁（未登录 401 / 非运营 403），
 * 门禁由转发的 Cookie 决定身份——所以这里不能因为"页面里已经判过角色"就省掉 Cookie 转发。
 * q / status 一律 encodeURIComponent：搜索框里的内容会原样进 URL，不转义等于把
 * "&"、"#" 之类的字符变成查询串的一部分（少一条结果或者多一个参数，都很难从页面上看出来）。
 */

export async function remoteAdminArticles(): Promise<AdminArticleRow[]> {
  return askList<AdminArticleRow>("/api/admin/articles", "articles");
}

export async function remoteAdminReview(): Promise<ReviewRow[]> {
  return askList<ReviewRow>("/api/admin/review", "review");
}

export async function remoteAdminUsers(q?: string): Promise<AdminUserRow[]> {
  const kw = encodeURIComponent(q ?? "");
  return askList<AdminUserRow>(`/api/admin/users?q=${kw}`, "users");
}

export async function remoteAdminReports(status?: string): Promise<ReportRow[]> {
  const st = encodeURIComponent(status ?? "");
  return askList<ReportRow>(`/api/admin/reports?status=${st}`, "reports");
}

export async function remoteAdminActions(limit: number): Promise<AdminActionLogRow[]> {
  return askList<AdminActionLogRow>(`/api/admin/actions?limit=${limit}`, "actions");
}

export async function remoteAdminOrders(): Promise<AdminOrderRow[]> {
  return askList<AdminOrderRow>("/api/admin/orders", "orders");
}

export async function remoteAdminComments(): Promise<AdminCommentRow[]> {
  return askList<AdminCommentRow>("/api/admin/comments", "comments");
}

/** 大盘：返回的是对象（days / ink / topArticles / tags / funnel 五个键平铺），不是列表。 */
export async function remoteAdminInsights(): Promise<AdminInsights> {
  return ask<AdminInsights>("/api/admin/insights");
}

/* ---------- 四个页面就地 SQL 的新家（P7f-1f-a） ----------
 *
 * 这一族比运营台八张表更隐蔽：SQL 就写在 page.tsx 里，连 lib/data.ts 都不经过，
 * 所以"被页面取走的导出函数"那种判据一条也数不到（闸门 18 拓宽之后才现形，见其文件头）。
 * 类型定义放在这里而不是 lib/data.ts：lib/data.ts 是"页面取数函数"的登记处，
 * 而这四个读**不经过 lib/data.ts**，页面直接 import 本模块——把类型放远处只会让人以为还有中间层。
 */

export type AdminOverview = {
  stats: {
    users: number;
    articles: number;
    pending: number;
    comments: number;
    qa: number;
    reports: number;
    tips: number;
    topup: number;
    banned: number;
  };
  recentQa: { question: string; createdAt: string }[];
};

export type MeProfile = {
  bio: string;
  avatarText: string;
  avatarTone: string;
  avatarShape: string;
  createdAt: string;
};

export type PointsOverview = {
  balance: number;
  quotaDone: boolean;
  streak: number;
  ledger: { delta: number; reason: string; at: string }[];
};

export type SecurityOverview = {
  audits: { id: number; event: string; ip: string | null; detail: string | null; created_at: string }[];
  totpEnabled: boolean;
};

export async function remoteAdminOverview(): Promise<AdminOverview> {
  return ask<AdminOverview>("/api/admin/overview");
}

export async function remoteMeProfile(): Promise<MeProfile> {
  return ask<MeProfile>("/api/me/profile");
}

export async function remotePointsOverview(): Promise<PointsOverview> {
  return ask<PointsOverview>("/api/me/points");
}

export async function remoteSecurityOverview(): Promise<SecurityOverview> {
  return ask<SecurityOverview>("/api/security/overview");
}

/* ---------- 会话与外链白名单（P7f-1f-b：闸门 18 的最后四条） ----------
 *
 * `currentUser` 走的是 `/api/auth/me`：Java 的 `SessionService.resolve` 与 Node 那句
 * `SELECT … FROM sessions JOIN users` 是同一套双保险（签名 + 库内有效 + uid 相符 + 未封禁），
 * 而且顺带做两件页面原本自己在进程里做的事——`last_seen_at` 的 60 秒节流写、每日 30 滴的懒发放。
 * 所以这一句调用的语义不只是"我是谁"，它同时兑现了墨仓页那句"访问任意页自动入仓"。
 *
 * 用 cache() 包一层：一次渲染里 Masthead 与页面各调一次是常态，不合并就会同一渲染打两次
 * /api/auth/me（顺带两次 UPDATE 尝试）。cache() 只合流同一请求内，不跨请求缓存。
 */

export const remoteCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const body = await ask<{ user: SessionUser | null }>("/api/auth/me");
  return body?.user ?? null;
});

/** 自己的活跃设备列表。键名沿用 Node 的 snake_case（组件类型就是这么写的）。 */
export async function remoteSessions(): Promise<SessionRow[]> {
  return askList<SessionRow>("/api/security/sessions", "sessions");
}

/** 放行域名（不含 DEFAULT_ALLOW，那一半留在 lib/link-policy.ts）。 */
export async function remoteAllowedDomains(): Promise<string[]> {
  return askList<string>("/api/links/allowed-domains", "domains");
}
