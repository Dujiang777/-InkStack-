#!/usr/bin/env node
// 闸门 19：页面读端点核对（用 MySQL 独立复算当裁判）。
//
// 为什么这一道必须存在：P7f-1d 迁走的这六条读，原本根本没有 HTTP 面——它们是 Server Component
// 在 Next 进程里直接摸 MySQL 的。于是对拍（闸门 1）看不见它们：两侧都得上 HTTP 才有的比；
// 契约基线（闸门 1′）也看不见，因为基线是从 Node 时代的**应答**冻结的，而它们从不应答。
// 等 app/api/** 与那份遗留读 SQL 一起删掉之后，"Java 这六条算得对不对"就再没有参照物了。
//
// 所以这里的裁判不是另一套实现，而是**从需求重新写一遍 SQL**：
// 每个数都由本脚本自己查库复算，再和 Java 的 HTTP 应答逐字段比。脚本里的 SQL 是照着
// Node 时代 lib/data.ts 的口径写的（那份源码在 git 里，见下面每条的出处），
// 但它住在闸门里、不依赖任何一栈的实现，所以删除 Node 侧不会削掉这一道。
//
// 三条纪律：
//   1) 宾语必须存在。库里没有任何关注关系时，"复算 == Java"是两条空数组在互相盖章——
//      这种判据一律记 SKIP 并说明原因，不记 PASS。
//   2) 身份必须验。四条 /api/me/* 只认请求 cookie 里那个人，签名上却不收 userId，
//      所以必须证明"换一个人问，答的就换一个人的数"，否则忘了读 cookie 也能全绿。
//   3) 并列不硬判。topAuthors 的 ORDER BY 存在同票可能，MySQL 不保证并列行稳定；
//      有并列时只比"排序键非递增 + 行内容集合"，不比并列内部的先后。
//
//   node scripts/pagereads-check.mjs
//
// 前提：Java 已启动（默认 http://localhost:3101），.env 的 DATABASE_URL 指向克隆库 inkstack_j。
// 整道闸门**只读**，不写库、不留数据。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";
const mysql = createRequire(import.meta.url)("mysql2/promise");

let pass = 0;
let fail = 0;
let skip = 0;
function check(cond, label, detail) {
  const text = typeof detail === "function" ? detail()
    : typeof detail === "string" ? detail : (detail === undefined ? "" : JSON.stringify(detail));
  if (cond) { pass++; console.log(`PASS  ${label}${text ? "  — " + text : ""}`); }
  else { fail++; console.log(`FAIL  ${label}  — ${text || "（无细节）"}`); }
  return !!cond;
}
function skipped(label, why) {
  skip++;
  console.log(`SKIP  ${label}  — ${why}`);
}
const brief = (v) => JSON.stringify(v)?.slice(0, 220) ?? "undefined";

/* ————————————————————— 库 ————————————————————— */

const dbUrl = new URL(env.DATABASE_URL);
const pool = await mysql.createConnection({
  host: dbUrl.hostname,
  port: Number(dbUrl.port || 3306),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.slice(1),
});
const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
const only = async (sql, params = []) => (await rows(sql, params))[0] ?? null;
const num = async (sql, params = []) => {
  const r = await only(sql, params);
  if (!r) return 0;
  const v = Object.values(r)[0];
  return v === null || v === undefined ? 0 : Number(v);
};

/* ————————————————————— HTTP ————————————————————— */

async function ask(urlPath, cookie) {
  let res;
  try {
    res = await fetch(JAVA + urlPath, {
      headers: { ...(cookie ? { cookie } : {}), accept: "application/json", "user-agent": "inkstack-pagereads" },
      cache: "no-store",
    });
  } catch (down) {
    return { status: 0, json: null, text: `${JAVA} 连不上：${down.cause?.code ?? down.message}`, backend: "" };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 由调用方判定 */ }
  return { status: res.status, json, text, backend: res.headers.get("x-backend") ?? "" };
}

async function login(email, password) {
  const res = await fetch(JAVA + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new Error(`登录失败（${email}）：${brief(body)}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error("登录成功但没有 ink_session");
  return cookie;
}

/** 三个已知身份：作者（有文章/专栏）、管理员、读者（有关注）。缺凭据就整条身份链判据 SKIP。 */
const ACTORS = {};
const actorErr = [];
for (const [who, pair] of Object.entries({
  writer: ["INK_WRITER_EMAIL", "INK_WRITER_PASSWORD"],
  test: ["INK_TEST_EMAIL", "INK_TEST_PASSWORD"],
  probe: ["INK_PROBE_EMAIL", "INK_PROBE_PASSWORD"],
})) {
  if (!env[pair[0]] || !env[pair[1]]) { actorErr.push(`${who} 缺凭据`); continue; }
  try {
    const cookie = await login(env[pair[0]], env[pair[1]]);
    const r = await only(`SELECT id, nickname FROM users WHERE email = ?`, [env[pair[0]]]);
    if (r) ACTORS[who] = { cookie, id: Number(r.id), nickname: String(r.nickname) };
  } catch (e) { actorErr.push(`${who}：${String(e.message).slice(0, 60)}`); }
}

/* ————————————————————— 复算口径 ————————————————————— */

/** 整数千分位：钉 en-US 分组符。Node 当年用运行时的 toLocaleString()，Java 钉 Locale.US，
 *  闸门再跟着 JVM 默认 locale 走的话，三方就会在换机器部署那天各说各话。 */
const grouped = (n) => new Intl.NumberFormat("en-US").format(n);

/** Node 的 mk()：earned=cur>=goal，progress=min(1,cur/goal)，文案=min(cur,goal)/goal。 */
const badge = (key, name, desc, icon, cur, goal) => ({
  key, name, desc, icon,
  earned: cur >= goal,
  progress: Math.min(1, cur / goal),
  progressText: `${grouped(Math.min(cur, goal))} / ${grouped(goal)}`,
});

/** 成就墙 14 枚的门槛表。出处：git HEAD~N 的 lib/data.ts listAchievements 那 14 句 mk()。 */
const WALL = (m) => [
  badge("first-post", "处女作", "发布第一篇公开文章", "初", m.articles, 1),
  badge("prolific", "笔耕不辍", "累计发布 5 篇文章", "耕", m.articles, 5),
  badge("voluminous", "著作等身", "累计发布 10 篇文章", "著", m.articles, 10),
  badge("reads-100", "初露锋芒", "文章总阅读破 100", "锋", m.reads, 100),
  badge("reads-1000", "洛阳纸贵", "文章总阅读破 1000", "贵", m.reads, 1000),
  badge("likes-10", "初识知音", "累计获赞 10", "知", m.likes, 10),
  badge("likes-50", "人气之星", "累计获赞 50", "星", m.likes, 50),
  badge("talk-10", "谈笑风生", "文章累计被评论 10 次", "谈", m.comments, 10),
  badge("streak-3", "三日不辍", "连续签到 3 天", "恒", m.streak, 3),
  badge("streak-7", "七日之约", "连续签到 7 天", "约", m.streak, 7),
  badge("rich", "墨水富翁", "墨水余额达 1000 滴", "富", m.balance, 1000),
  badge("social", "以文会友", "关注 3 位作者", "友", m.following, 3),
  badge("beloved", "众望所归", "收获 5 位粉丝", "望", m.fans, 5),
  badge("curious", "十问分身", "与分身问答 10 次", "问", m.qa, 10),
];

/** 连签：从今天（或昨天）往回数连续日，最多 30 天。日历日直接问 MySQL，绕开驱动时区。 */
async function streakOf(uid) {
  const days = new Set((await rows(
    `SELECT DATE_FORMAT(checkin_date,'%Y-%m-%d') AS d FROM checkins
      WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 30`, [uid]
  )).map((r) => r.d));
  const key = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  let i = days.has(key(0)) ? 0 : days.has(key(1)) ? 1 : -1;
  let streak = 0;
  while (i >= 0 && i < 30 && days.has(key(i))) { streak++; i++; }
  return streak;
}

async function metricsOf(uid) {
  const published = `author_id = ? AND status = 'published' AND review_status = 'approved'`;
  const art = await only(
    `SELECT COUNT(*) AS n_articles, IFNULL(SUM(read_count),0) AS n_reads,
            IFNULL(SUM(like_count),0) AS n_likes, IFNULL(SUM(comment_count),0) AS n_comments
       FROM articles WHERE ${published}`, [uid]);
  return {
    articles: Number(art?.n_articles ?? 0),
    reads: Number(art?.n_reads ?? 0),
    likes: Number(art?.n_likes ?? 0),
    comments: Number(art?.n_comments ?? 0),
    balance: await num(`SELECT points_balance FROM users WHERE id = ?`, [uid]),
    following: await num(`SELECT COUNT(*) FROM follows WHERE follower_id = ?`, [uid]),
    fans: await num(`SELECT COUNT(*) FROM follows WHERE followee_id = ?`, [uid]),
    qa: await num(`SELECT COUNT(*) FROM agent_qa WHERE asker_id = ?`, [uid]),
    streak: await streakOf(uid),
  };
}

/** 专栏题名建议的原料：tags 列按文本取回，本脚本自己 JSON.parse——两栈各自的解析路径都不借用。 */
async function suggestionsOf(uid) {
  const SUFFIX = ["手记", "研习录", "漫谈", "札记", "专栏"];
  const counter = new Map();
  for (const r of await rows(
    `SELECT CAST(tags AS CHAR) AS tags FROM articles
      WHERE author_id = ? AND status = 'published' AND review_status = 'approved' AND tags IS NOT NULL`, [uid])) {
    let list;
    try { list = JSON.parse(r.tags); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const t of list.map(String)) counter.set(t, (counter.get(t) ?? 0) + 1);
  }
  return [...counter.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([tag, n], i) => ({
      title: `${tag}${SUFFIX[i % SUFFIX.length]}`.slice(0, 60),
      hint: `已有 ${n} 篇「${tag}」文章可以成柜`,
    }));
}

/* ————————————————————— 开跑 ————————————————————— */

console.log(`Java：${JAVA}    库：${dbUrl.pathname.slice(1)}`);
console.log(`身份：${Object.keys(ACTORS).join("/") || "无"}${actorErr.length ? `（${actorErr.join("；")}）` : ""}`);
if (dbUrl.pathname.slice(1) !== "inkstack_j") {
  console.log(`⚠ 连的是 ${dbUrl.pathname.slice(1)}，不是克隆库 inkstack_j——本闸门只读，不动数据，但请确认这是你想要的。`);
}

/** 六条都得由 Java 应答：x-backend 是唯一硬证据（Node 侧这四条 /me 读根本没有路由）。 */
const endpoints = [
  "/api/platform/stats", "/api/platform/top-authors?limit=5",
  "/api/me/achievements", "/api/me/following-feed", "/api/me/badge-reward",
  "/api/me/series-title-suggestions",
];
for (const p of endpoints) {
  const r = await ask(p, ACTORS.writer?.cookie);
  check(r.status === 200 && r.backend === "inkstack-java",
    `${p} 由 Java 正常应答`, `status=${r.status} backend=${r.backend || "无"}`);
}

/* ① 全站计数 */
{
  const expect = {
    articles: await num(`SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='approved'`),
    authors: await num(`SELECT COUNT(DISTINCT author_id) FROM articles WHERE status='published'`),
    qaTotal: await num(`SELECT COUNT(*) FROM agent_qa`),
    tipsTotal: await num(`SELECT IFNULL(SUM(amount),0) FROM article_tips`),
  };
  const got = (await ask("/api/platform/stats")).json ?? {};
  check(expect.articles === Number(got.articles), "全站·文章数与复算相等", `期望 ${expect.articles} 实得 ${got.articles}`);
  check(expect.authors === Number(got.authors), "全站·作者数与复算相等", `期望 ${expect.authors} 实得 ${got.authors}`);
  check(expect.qaTotal === Number(got.qaTotal), "全站·分身问答总数与复算相等", `期望 ${expect.qaTotal} 实得 ${got.qaTotal}`);
  check(expect.tipsTotal === Number(got.tipsTotal), "全站·打赏总额与复算相等", `期望 ${expect.tipsTotal} 实得 ${got.tipsTotal}`);
}

/* ② 作者榜 */
{
  const expect = await rows(
    `SELECT u.id, u.nickname, COALESCE(u.avatar_text,'') AS avatarText,
            COALESCE(u.avatar_tone,'') AS avatarTone, COALESCE(u.avatar_shape,'') AS avatarShape,
            IFNULL(SUM(a.like_count),0) AS likes, COUNT(a.id) AS articles, IFNULL(SUM(a.read_count),0) AS readTotal
       FROM articles a JOIN users u ON u.id = a.author_id
      WHERE a.status='published' AND a.review_status='approved'
      GROUP BY a.author_id, u.id, u.nickname, u.avatar_text, u.avatar_tone, u.avatar_shape
      ORDER BY likes DESC, readTotal DESC LIMIT 50`);
  const norm = (r) => ({
    id: Number(r.id), nickname: String(r.nickname),
    avatarText: String(r.avatarText || "墨"), avatarTone: String(r.avatarTone ?? ""),
    avatarShape: String(r.avatarShape ?? ""), likes: Number(r.likes),
    articles: Number(r.articles), readTotal: Number(r.readTotal),
  });
  const top5 = (await ask("/api/platform/top-authors?limit=5")).json?.authors ?? [];
  const ranked = expect.map(norm);
  if (check(ranked.length > 0, "作者榜宾语存在", `${ranked.length} 位候选`)) {
    const orderHolds = (list) => list.every((x, i) => i === 0
      || list[i - 1].likes > x.likes
      || (list[i - 1].likes === x.likes && list[i - 1].readTotal >= x.readTotal));
    const tie = new Set(ranked.map((r) => `${r.likes}|${r.readTotal}`)).size < ranked.length;
    const want = ranked.slice(0, top5.length);
    if (tie) {
      // 并列时 MySQL 不保证先后，比"排序键非递增 + 行内容集合"两样，不比并列内部顺序。
      const sameSet = top5.length > 0 && JSON.stringify(top5.map(norm).sort((a, b) => a.id - b.id))
        === JSON.stringify(want.sort((a, b) => a.id - b.id));
      check(sameSet && orderHolds(top5.map(norm)), "作者榜前 N 名与复算相等（含并列，只比集合与序键）",
        `实得 ${brief(top5.map(norm))}`);
    } else {
      // top5.length>0 是这条判据的宾语：端点空手回来时必须判负，不能让 [] 和 slice(0,0) 互相盖章。
      check(top5.length > 0 && JSON.stringify(top5.map(norm)) === JSON.stringify(ranked.slice(0, top5.length)),
        "作者榜前 N 名与复算逐行相等", `实得 ${brief(top5.map(norm).slice(0, 2))}`);
    }
    const top2 = (await ask("/api/platform/top-authors?limit=2")).json?.authors ?? [];
    check(top2.length === 2 && JSON.stringify(top2.map(norm)) === JSON.stringify(ranked.slice(0, 2)),
      "作者榜 limit=2 是 limit=5 的前缀（截断一致）", `${top2.length} 行`);
  }
  // 越界 limit 不能变成 500，也不能悄悄把 SQL 语法里的负数放出去。
  for (const bad of ["0", "-1", "99999"]) {
    const r = await ask(`/api/platform/top-authors?limit=${bad}`);
    check(r.status === 200 && Array.isArray(r.json?.authors), `作者榜 limit=${bad} 不 500 且夹回区间`,
      `status=${r.status} 行数=${r.json?.authors?.length}`);
  }
}

/* ③ 关注动态流：内容 + 身份绑定 */
{
  const feedOf = async (uid) => rows(
    `SELECT a.slug, a.title, a.summary, a.author_id AS authorId, u.nickname AS author,
            COALESCE(u.avatar_text,'') AS authorAvatar,
            DATE_FORMAT(a.published_at,'%Y-%m-%d') AS publishedAt,
            a.read_count AS readCount, a.like_count AS likeCount, a.comment_count AS commentCount
       FROM follows f JOIN articles a ON a.author_id = f.followee_id JOIN users u ON u.id = a.author_id
      WHERE f.follower_id = ? AND a.status='published' AND a.review_status='approved'
      ORDER BY a.published_at DESC LIMIT 6`, [uid]);
  const norm = (r) => ({
    slug: String(r.slug), title: String(r.title), summary: String(r.summary ?? ""),
    authorId: Number(r.authorId), author: String(r.author),
    authorAvatar: String(r.authorAvatar || "墨"), publishedAt: String(r.publishedAt),
    readCount: Number(r.readCount ?? 0), likeCount: Number(r.likeCount ?? 0),
    commentCount: Number(r.commentCount ?? 0),
  });
  const withFeed = [];
  for (const [who, a] of Object.entries(ACTORS)) {
    const n = await num(`SELECT COUNT(*) FROM follows WHERE follower_id = ?`, [a.id]);
    if (n > 0) withFeed.push({ who, ...a, rows: await feedOf(a.id) });
  }
  if (!check(withFeed.length > 0, "关注流宾语存在（有人真的关注了作者）",
    withFeed.length ? "" : "三个人都没关注任何人")) {
    skipped("关注流与复算逐行相等", "库里没有任何关注关系，两条空数组互相盖章不算测到");
    skipped("关注流认 cookie 不认人", "同上");
  } else {
    for (const a of withFeed) {
      const got = (await ask("/api/me/following-feed?limit=6", a.cookie)).json?.items ?? [];
      const want = a.rows.map(norm);
      check(got.length > 0 && JSON.stringify(got.map(norm)) === JSON.stringify(want),
        `${a.who} 的关注流与复算逐行相等`, `复算 ${want.length} 行 / 实得 ${got.length} 行`);
    }
    if (withFeed.length < 2) {
      skipped("换 cookie 就换一份动态流（这四条端点只认会话，不收 userId）",
        `只有 ${withFeed.map((a) => a.who).join("/")} 一个账号有可显示的关注流，比不出"换人换答案"`);
    } else {
      const [x, y] = withFeed;
      const a = ((await ask("/api/me/following-feed?limit=6", x.cookie)).json?.items ?? []).map(norm);
      const b = ((await ask("/api/me/following-feed?limit=6", y.cookie)).json?.items ?? []).map(norm);
      const aOwns = a.every((i) => x.rows.some((r) => String(r.slug) === i.slug));
      check(JSON.stringify(a) !== JSON.stringify(b) && aOwns,
        "换 cookie 就换一份动态流（这四条端点只认会话，不收 userId）",
        `${x.who} ${a.length} 行 / ${y.who} ${b.length} 行`);
    }
  }
}

/* ④ 成就墙 */
{
  for (const [who, a] of Object.entries(ACTORS)) {
    const m = await metricsOf(a.id);
    const got = (await ask("/api/me/achievements", a.cookie)).json?.achievements ?? [];
    const want = WALL(m);
    check(got.length === want.length,
      `${who} 的成就墙是完整 14 枚`, `实得 ${got.length} 枚（读数 ${brief(m)}）`);
    const mism = [];
    for (let i = 0; i < want.length; i++) {
      const g = got[i] ?? {};
      for (const k of ["key", "name", "desc", "icon", "earned", "progress", "progressText"]) {
        if (g[k] !== want[i][k]) mism.push(`${want[i].key}.${k}: 期望 ${brief(want[i][k])} 实得 ${brief(g[k])}`);
      }
    }
    check(mism.length === 0, `${who} 的成就墙 14 枚逐字段与复算相等`, mism.slice(0, 4).join(" | "));
  }
  // 门槛文案是显示给人看的，任何一枚漂了就写在墙上——单独点出来，好过埋在 mism 里。
  const first = (await ask("/api/me/achievements", ACTORS.writer?.cookie)).json?.achievements ?? [];
  check(first.map((x) => x.key).join(",") === WALL({ articles: 0, reads: 0, likes: 0, comments: 0, balance: 0, following: 0, fans: 0, qa: 0, streak: 0 }).map((x) => x.key).join(","),
    "成就顺序与 key 名单未漂", first.map((x) => x.key).join(","));
}

/* ⑤ 集齐奖励是否领过 */
{
  for (const [who, a] of Object.entries(ACTORS)) {
    const expect = await num(
      `SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND reason = ?`, [a.id, "集齐徽章奖励"]);
    const got = (await ask("/api/me/badge-reward", a.cookie)).json?.claimed;
    check(typeof got === "boolean" && got === (expect > 0),
      `${who} 的领取状态与流水一致`, `流水 ${expect} 条 / claimed=${got}`);
  }
}

/* ⑥ 专栏题名建议 */
{
  let tested = 0;
  for (const [who, a] of Object.entries(ACTORS)) {
    const want = await suggestionsOf(a.id);
    if (!want.length) continue;
    tested++;
    const got = (await ask("/api/me/series-title-suggestions", a.cookie)).json?.suggestions ?? [];
    check(JSON.stringify(got) === JSON.stringify(want),
      `${who} 的专栏题名建议与复算全等（含后缀轮换与 hint 数字）`, `期望 ${brief(want)} / 实得 ${brief(got)}`);
  }
  if (!tested) skipped("专栏题名建议与复算全等", "没有人有 ≥2 篇同标签的过审文章，建议恒为空");
}

/* ⑦ 越权：游客不能问到别人的数 */
for (const p of ["/api/me/achievements", "/api/me/following-feed", "/api/me/badge-reward", "/api/me/series-title-suggestions"]) {
  const r = await ask(p);
  check(r.status === 401, `游客打 ${p} 必须 401，不能回任何人的数据`, `status=${r.status} ${brief(r.json).slice(0, 60)}`);
  // 畸形会话也不能"顺手当成某个默认用户"——那是一条把身份判错却仍然 200 的隐蔽路径。
  const forged = await ask(p, "ink_session=not-a-real-session-value");
  check(forged.status === 401, `伪造会话打 ${p} 同样 401`, `status=${forged.status}`);
}
for (const p of ["/api/platform/stats", "/api/platform/top-authors?limit=5"]) {
  const r = await ask(p);
  check(r.status === 200, `游客可看公开统计 ${p}`, `status=${r.status}`);
}

await pool.end();
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ""}`);
process.exit(fail ? 1 : 0);
