#!/usr/bin/env node
// 闸门 19：页面读端点核对（用 MySQL 独立复算当裁判）。
//
// 为什么这一道必须存在：P7f-1d / P7f-1e / P7f-1f-a 迁走的这**十八读**，原本根本没有 HTTP 面——
// 它们是 Server Component 在 Next 进程里直接摸 MySQL 的（最后那四条更特殊：SQL 就写在 page.tsx 里，
// 连 lib/data.ts 都不经过，所以闸门 18 的第一版一条也数不到）。
// ⑩ 那四条（P7f-1f-b）是同一件事的另一半：它们住在**全站共用**的 lib 里而不是页面里，
// 其中"每日 30 滴"更不是读，是渲染时直接发生的一次写——所以那一段的判据也是写的判据。
// 于是对拍（闸门 1）看不见它们：两侧都得上 HTTP 才有的比；
// 契约基线（闸门 1′）也看不见，因为基线是从 Node 时代的**应答**冻结的，而它们从不应答。
// 等 app/api/** 与那份遗留读 SQL 一起删掉之后，"Java 这些算得对不对"就再没有参照物了。
//
// 所以这里的裁判不是另一套实现，而是**从需求重新写一遍 SQL**：
// 每个数都由本脚本自己查库复算，再和 Java 的 HTTP 应答逐字段比。脚本里的 SQL 是照着
// Node 时代 lib/data.ts 的口径写的（那份源码在 git 里，见下面每条的出处），
// 但它住在闸门里、不依赖任何一栈的实现，所以删除 Node 侧不会削掉这一道。
//
// 四条纪律：
//   1) 宾语必须存在。库里没有任何关注关系时，"复算 == Java"是两条空数组在互相盖章——
//      这种判据一律记 SKIP 并说明原因，不记 PASS。
//   2) 身份必须验。四条 /api/me/* 只认请求 cookie 里那个人，签名上却不收 userId，
//      所以必须证明"换一个人问，答的就换一个人的数"，否则忘了读 cookie 也能全绿。
//   3) 并列不硬判。运营台那些 `ORDER BY 时间 DESC LIMIT n` 里，MySQL 不保证并列行的先后：
//      窗口内有并列时不要求同序，边界上并列时不要求同一个集合——其余情况一律逐行钉死。
//   4) 带门禁的读先验门禁。用户管理那张表回邮箱，所以游客 / 伪造会话 / 非运营三种人
//      必须先被 401 / 403 挡住，才轮得到比内容；比对失败时邮箱一类字段不外显。
//
//   node scripts/pagereads-check.mjs
//
// 前提：Java 已启动（默认 http://localhost:3101），.env 的 DATABASE_URL 指向克隆库 inkstack_j。
// 判据本身只读，但有五处**临时夹具**（⑧ 的一行待审稿与三条举报、⑨.2b 把 probe 的印文临时清成
// 空串、⑩.1b 临时吊销一枚刚签发的会话、⑩.3 三行 link_whitelist、⑩.4 一次真实的每日发墨），
// 全部在 finally 里删除／按原值恢复并复核残留——跑完库里不该有任何闸门痕迹。
// ⑩.4 是其中唯一的一处**写业务**：回滚按余额、发放日、流水 id 三项精确复原，不靠重放一遍业务。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

/**
 * 并列感知的列表比对。want 是复算的候选全集（已按端点声称的次序排好）。
 * `__ord` 必须是**可比较的原语**（数字，或 '%Y-%m-%d %H:%i:%s' 那种字典序即时序的串）：
 * 直接把 mysql2 还回来的 Date 塞进去，比的就是 "Mon Sep 21…" 这种字符串，
 * 闸门会红在一条根本不存在的时间倒序上。
 */
function listCheck(label, { want, limit, key, got, dir = "desc", redact = [] }) {
  const expectedLen = Math.min(limit, want.length);
  if (!check(Array.isArray(got) && got.length === expectedLen,
    `${label} 条数与复算一致`, `期望 ${expectedLen} 实得 ${got?.length ?? "非数组"}`)) return;
  if (!want.length) { skipped(`${label} 逐字段与复算相等`, "复算为空集，比不出任何东西"); return; }

  const byKey = new Map(want.map((r) => [key(r), r]));
  const strays = [];
  const fieldDiff = [];
  for (const g of got) {
    const w = byKey.get(key(g));
    if (!w) { strays.push(key(g)); continue; }
    for (const [f, v] of Object.entries(g)) {
      if (String(v) !== String(w[f])) {
        const hide = redact.includes(f);
        fieldDiff.push(`${String(key(g))}.${f}: 期望 ${hide ? "‹隐去›" : brief(w[f])} 实得 ${hide ? "‹隐去›" : brief(v)}`);
      }
    }
  }
  check(strays.length === 0, `${label} 每一行都在复算结果里`, strays.slice(0, 3).join(" "));
  check(fieldDiff.length === 0, `${label} 逐字段与复算相等`,
    fieldDiff.slice(0, 3).join(" | ") || `${got.length} 行全等${redact.length ? `（${redact.join("/")} 不外显）` : ""}`);

  const ordOf = (g) => {
    const w = byKey.get(key(g));
    return w ? w.__ord : null;
  };
  const keys = got.map(ordOf);
  check(keys.every((k) => k !== null && k !== undefined), `${label} 每一行都取得到排序键`, `${keys.length} 行`);
  const mono = keys.every((k, i) => i === 0 || (dir === "desc" ? k <= keys[i - 1] : k >= keys[i - 1]));
  check(mono, `${label} 排序键单调（${dir}）`, `${keys[0]} … ${keys[keys.length - 1]}`);

  const windowRows = want.slice(0, expectedLen);
  const ordKeys = windowRows.map((r) => r.__ord);
  const tieInside = new Set(ordKeys).size < ordKeys.length;
  const boundaryTie = want.length > expectedLen
    && windowRows[expectedLen - 1].__ord === want[expectedLen].__ord;
  if (boundaryTie) {
    skipped(`${label} 窗口集合与复算完全一致`,
      `第 ${expectedLen}/${expectedLen + 1} 名的排序键并列，MySQL 不保证谁进窗口——只钉"每一行都在候选里"`);
  } else {
    const sameSet = got.map(key).sort().join("\u0001") === windowRows.map(key).sort().join("\u0001");
    check(sameSet, `${label} 窗口集合与复算完全一致`,
      `期望 ${brief(windowRows.slice(0, 2).map(key))} 实得 ${brief(got.slice(0, 2).map(key))}`);
  }
  if (!tieInside && !boundaryTie) {
    check(got.map(key).join("\u0001") === windowRows.map(key).join("\u0001"),
      `${label} 无并列时逐行同序`, `实得 ${brief(got.map(key).slice(0, 3))}`);
  } else {
    skipped(`${label} 无并列时逐行同序`, "窗口内有并列，行序不由 SQL 决定");
  }
}

/**
 * 闸门自己出错时必须**记一项失败并退出 1**，而不是甩一段栈就完事。
 * 区别不是好看：栈会被终端截掉、CI 里只剩一句非零退出，而 "闸门自身异常 + 首两帧" 会让人
 * 去查闸门——这比"它安静地少报了几项"好得多。studio-check 那一道的清场就是靠这条线索找到的。
 */
function died(e) {
  console.error(`\n闸门自身异常：${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`);
  console.error(`  位置：${String(e?.stack ?? "").split("\n").slice(1, 3).join(" | ").slice(0, 240)}`);
  console.log(`合计 ${pass + fail + 1} 项，失败 ${fail + 1} 项（含闸门自身异常一项）`);
  process.exit(1);
}
process.on("unhandledRejection", died);
process.on("uncaughtException", died);

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

/** 十八条都得由 Java 应答：x-backend 是唯一硬证据（Node 侧这些读根本没有路由）。 */
const endpoints = [
  "/api/platform/stats", "/api/platform/top-authors?limit=5",
  "/api/me/achievements", "/api/me/following-feed", "/api/me/badge-reward",
  "/api/me/series-title-suggestions",
  // 运营台八条要带运营身份才 200，其余身份在 ⑧.1 里单独判
  "/api/admin/articles", "/api/admin/review", "/api/admin/users?q=", "/api/admin/reports",
  "/api/admin/actions", "/api/admin/orders", "/api/admin/comments", "/api/admin/insights",
];
const adminCookie = ACTORS.test?.cookie ?? ACTORS.writer?.cookie;
for (const p of endpoints) {
  const r = await ask(p, p.startsWith("/api/admin") ? adminCookie : ACTORS.writer?.cookie);
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
for (const p of ["/api/me/achievements", "/api/me/following-feed", "/api/me/badge-reward", "/api/me/series-title-suggestions",
  "/api/me/profile", "/api/me/points", "/api/security/overview"]) {
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

/* ⑧ 运营台八张表（P7f-1e）
 *
 * 这一族比前六条多两件事：① 它们是**带门禁的读**（用户管理那张表回邮箱），
 * 所以除了内容对不对，必须先证明"游客 / 伪造会话 / 非运营"三种人一个字节都拿不到；
 * ② 它们几乎全是 `ORDER BY 时间 DESC LIMIT n`，而 MySQL 对**并列行不保证稳定顺序**——
 * 硬按行序比，闸门就会随机红，那种红会让人开始怀疑所有绿。
 * 所以列表比对交给顶层的 listCheck：并列只在"窗口内部"和"窗口边界"两处真正影响结果，
 * 就只在那两处放开，其余一律逐行钉死。
 */
{
  const ADMIN_PATHS = ["/api/admin/articles", "/api/admin/review", "/api/admin/users?q=",
    "/api/admin/reports", "/api/admin/actions", "/api/admin/orders", "/api/admin/comments",
    "/api/admin/insights"];

  /** 列表比对用顶层的 listCheck（P7f-1f-a 提出来的，⑨ 那四条读同样要用）。 */

  const staff = ACTORS.test;
  const notStaff = ACTORS.writer ?? ACTORS.probe;
  if (!staff) {
    skipped("运营台八条读的内容判据", ".env 里没有运营账号（INK_TEST_*），拿不到 200 的应答");
  }

  /* ⑧.1 门禁：读侧漏出来的是邮箱和未上架稿件，三种人必须一个字节都拿不到 */
  for (const p of ADMIN_PATHS) {
    const guest = await ask(p);
    check(guest.status === 401, `游客打 ${p} 必须 401`, `status=${guest.status} ${brief(guest.json).slice(0, 50)}`);
    const forged = await ask(p, "ink_session=not-a-real-session-value");
    check(forged.status === 401, `伪造会话打 ${p} 同样 401`, `status=${forged.status}`);
    if (notStaff) {
      const out = await ask(p, notStaff.cookie);
      check(out.status === 403 && out.json?.error === "仅管理团队可操作",
        `非运营（${notStaff.nickname}）打 ${p} 必须 403 且文案不变`, `status=${out.status} ${brief(out.json).slice(0, 60)}`);
    }
  }
  if (!notStaff) skipped("非运营打运营台读必须 403", "只有一个可用身份，比不出'登录但不是运营'");

  if (staff) {
    const ck = staff.cookie;

    /* ⑧.1b 给"没有宾语"的两条造宾语：待审稿一条、举报两条（其中一条指向已不存在的内容）。
     *
     * 为什么这一道允许写库而其余只读：审核队列与举报队列在克隆库里**本来就是空的**，
     * 空集比空集恒等，那两条迁址判据就会永远 SKIP——等于八条里悄悄少测两条。
     * 判完立刻删，且删除放在 finally 里：闸门异常也不能把夹具留在库里（残留会让下一次
     * 的"窗口集合"莫名多一行，那种红最难查）。
     */
    const stamp = Date.now();
    const slug = `p7f1e-fixture-${stamp}`;
    const made = { slugs: [slug], reportIds: [] };
    try {
      await pool.query(
        `INSERT INTO articles (author_id, slug, title, md_content, summary, status, review_status,
                               read_count, like_count, comment_count, published_at, created_at, updated_at)
         VALUES (?, ?, ?, '正文若干字，够长。', '夹具摘要', 'published', 'pending', 3, 1, 0, NOW(), NOW(), NOW())`,
        [ACTORS.writer?.id ?? 5, slug, `闸门19·待审夹具 ${stamp}`]);
      const target = (await only(`SELECT id FROM articles WHERE slug = ?`, [slug]))?.id;
      const [r1] = await pool.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, status, created_at)
         VALUES (?, 'article', ?, '闸门19夹具：内容违规', 'open', NOW())`,
        [ACTORS.probe?.id ?? ACTORS.writer?.id ?? 5, target]);
      made.reportIds.push(Number(r1.insertId));
      // 指向一条不存在的评论：targetTitle 落 NULL，落成"（内容已不存在）"那一支
      const [r2] = await pool.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, status, created_at)
         VALUES (?, 'comment', ?, '闸门19夹具：目标已删', 'open', NOW())`,
        [ACTORS.probe?.id ?? ACTORS.writer?.id ?? 5, 999999999]);
      made.reportIds.push(Number(r2.insertId));
      // reporter_id 为 NULL 的匿名举报：落成 '游客' 那一支。反证时才发现这一支此前**从没被走到**
      // （库里每条举报都实名），把闸门里的 COALESCE 默认值从 '游客' 改成 '匿名' 它一声不响。
      const [r3] = await pool.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, status, created_at)
         VALUES (NULL, 'article', ?, '闸门19夹具：匿名举报', 'dismissed', NOW())`, [target]);
      made.reportIds.push(Number(r3.insertId));

      /* ⑧.2 内容管理 */
    {
      const want = await rows(
        `SELECT a.slug AS k, a.slug, a.title, u.nickname AS author, a.status,
                a.review_status AS reviewStatus,
                IF(a.pinned = 1, 'true', 'false') AS pinned,
                IF(a.featured = 1, 'true', 'false') AS featured,
                IFNULL(a.read_count, 0) AS readCount, IFNULL(a.comment_count, 0) AS commentCount,
                IFNULL(a.unlock_price, 0) AS unlockPrice,
                IFNULL(DATE_FORMAT(a.published_at,'%Y-%m-%d'), '—') AS publishedAt,
                DATE_FORMAT(a.updated_at,'%Y-%m-%d %H:%i:%s') AS __o
           FROM articles a JOIN users u ON u.id = a.author_id
          ORDER BY a.updated_at DESC LIMIT 100`);
      const got = (await ask("/api/admin/articles", ck)).json?.articles ?? [];
      listCheck("内容管理", {
        want: want.map((r) => ({ ...r, __ord: String(r.__o) })), limit: 100,
        key: (r) => r.slug, got,
      });
    }
    /* ⑧.3 审核队列 */
    {
      const want = await rows(
        `SELECT a.slug, a.title, u.nickname AS author, IFNULL(a.summary,'') AS summary,
                IFNULL(DATE_FORMAT(a.updated_at,'%m-%d %H:%i'),'—') AS submittedAt,
                DATE_FORMAT(a.updated_at,'%Y-%m-%d %H:%i:%s') AS __o
           FROM articles a JOIN users u ON u.id = a.author_id
          WHERE a.review_status = 'pending' AND a.status = 'published'
          ORDER BY a.updated_at ASC LIMIT 50`);
      const got = (await ask("/api/admin/review", ck)).json?.review ?? [];
      listCheck("审核队列", {
        want: want.map((r) => ({ ...r, __ord: String(r.__o) })), limit: 50,
        key: (r) => r.slug, got, dir: "asc",
      });
    }
    /* ⑧.4 用户管理：含 q 过滤与那条 '%%' 恒真的怪写法 */
    {
      const usersOf = async (like) => rows(
        `SELECT u.id AS k, u.id, u.nickname, u.email, u.role,
                IF(u.banned = 1, 'true', 'false') AS banned,
                IFNULL(u.points_balance, 0) AS points,
                (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id) AS articleCount,
                IFNULL(DATE_FORMAT(u.created_at,'%Y-%m-%d'),'—') AS createdAt, u.id AS __o
           FROM users u
          WHERE ? = '%%' OR u.nickname LIKE ? OR u.email LIKE ?
          ORDER BY u.id ASC LIMIT 200`, [like, like, like]);
      const all = await usersOf("%%");
      const gotAll = (await ask("/api/admin/users?q=", ck)).json?.users ?? [];
      listCheck("用户管理（空 q）", {
        want: all.map((r) => ({ ...r, __ord: Number(r.__o) })), limit: 200,
        key: (r) => String(r.id), got: gotAll, dir: "asc", redact: ["email"],
      });
      // 搜索框留空格：trim 完是空串，Node 那句 '%%' = '%%' 恒真 → 与"什么都没搜"同一个结果
      const gotBlank = (await ask("/api/admin/users?q=%20%20", ck)).json?.users ?? [];
      check(JSON.stringify(gotBlank) === JSON.stringify(gotAll),
        "q 只有空白时等于没搜（'%%' 恒真那条分支）", `${gotBlank.length} 行 / 全量 ${gotAll.length} 行`);
      // q='%' 时 like 变成 '%%%'，仍然全匹配——这是既有行为，不是修好的 bug
      const gotPct = (await ask("/api/admin/users?q=%25", ck)).json?.users ?? [];
      check(JSON.stringify(gotPct) === JSON.stringify(gotAll),
        "q='%' 落进通配而不是字面匹配（LIKE 不转义，既有口径）", `${gotPct.length} 行`);
      if (all.length) {
        const target = all[Math.floor(all.length / 2)];
        const wantOne = await usersOf(`%${String(target.nickname)}%`);
        const gotOne = (await ask(`/api/admin/users?q=${encodeURIComponent(String(target.nickname))}`, ck)).json?.users ?? [];
        check(gotOne.length === wantOne.length
          && gotOne.map((r) => r.id).sort((a, b) => a - b).join() === wantOne.map((r) => Number(r.id)).sort((a, b) => a - b).join(),
          `q=${target.nickname} 命中集合与复算一致`, `期望 ${wantOne.length} 人 实得 ${gotOne.length} 人`);
      }
    }
    /* ⑧.5 举报队列：带 status 与不带 status 是两条分支 */
    {
      const reportsOf = (status) => rows(
        `SELECT r.id AS k, r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.status,
                COALESCE(ru.nickname,'游客') AS reporter,
                IFNULL(CASE r.target_type
                  WHEN 'article' THEN (SELECT a.title FROM articles a WHERE a.id = r.target_id)
                  ELSE (SELECT CONCAT('评论：', LEFT(c.content, 40)) FROM comments c WHERE c.id = r.target_id)
                END, '（内容已不存在）') AS targetTitle,
                IFNULL(DATE_FORMAT(r.created_at,'%m-%d %H:%i'),'—') AS createdAt,
                DATE_FORMAT(r.created_at,'%Y-%m-%d %H:%i:%s') AS __o
           FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id
          ${status ? "WHERE r.status = ?" : ""}
          ORDER BY r.created_at DESC LIMIT 100`,
        status ? [status] : []);
      const all = await reportsOf(null);
      const gotReports = (await ask("/api/admin/reports", ck)).json?.reports ?? [];
      listCheck("举报队列（全部）", {
        want: all.map((r) => ({ ...r, __ord: String(r.__o) })), limit: 100,
        key: (r) => String(r.id), got: gotReports,
      });
      const open = await reportsOf("open");
      listCheck("举报队列（status=open）", {
        want: open.map((r) => ({ ...r, __ord: String(r.__o) })), limit: 100,
        key: (r) => String(r.id), got: (await ask("/api/admin/reports?status=open", ck)).json?.reports ?? [],
      });
      check(all.length === 0 || open.every((r) => r.status === "open"),
        "status 过滤真的在过滤", `全部 ${all.length} 条 / open ${open.length} 条`);
      // 分支覆盖必须被证明"走到了"，不然等于是两条没测过的支路：
      //   ① targetType 两种取值都出现过（article 走文章标题、comment 走"评论：…"）
      //   ② 目标已被删 → 落成"（内容已不存在）"那一支（夹具里专门种了一条指向不存在的评论）
      const kinds = new Set(gotReports.map((r) => r.targetType));
      check(kinds.has("article") && kinds.has("comment"),
        "举报队列两种目标类型都走到", `${[...kinds].join("/") || "空"}`);
      check(gotReports.some((r) => r.targetTitle === "（内容已不存在）"),
        "举报队列覆盖到'目标已删'那一支（targetTitle 的 NULL 兜底）",
        brief(gotReports.map((r) => r.targetTitle).slice(0, 3)));
      check(gotReports.some((r) => r.reporter === "游客"),
        "举报队列覆盖到'匿名举报'那一支（reporter_id 为 NULL）",
        brief(gotReports.map((r) => r.reporter).slice(0, 3)));
      // 夹具里特意放了一条 dismissed：过滤为 open 时它必须不在，否则 status 那条 WHERE 是假的
      check(gotReports.some((r) => r.status === "dismissed"),
        "举报队列里确有非 open 状态可被过滤掉", `状态构成 ${JSON.stringify(gotReports.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}))}`);
    }
    /* ⑧.6 审计日志：limit 的 Number(x)||30 那条兜底 */
    {
      const actionsOf = (n) => rows(
        `SELECT g.id AS k, g.id, COALESCE(u.nickname,'未知') AS admin, g.action,
                g.target_type AS targetType, CAST(g.target_id AS CHAR) AS targetId,
                IF(g.detail IS NULL OR g.detail = '', NULL, g.detail) AS detail,
                IFNULL(DATE_FORMAT(g.created_at,'%m-%d %H:%i'),'—') AS createdAt,
                DATE_FORMAT(g.created_at,'%Y-%m-%d %H:%i:%s') AS __o
           FROM admin_actions g LEFT JOIN users u ON u.id = g.admin_id
          ORDER BY g.created_at DESC LIMIT ${n}`);
      const all30 = await actionsOf(30);
      listCheck("审计日志（缺省 limit）", {
        want: all30.map((r) => ({ ...r, __ord: String(r.__o) })), limit: 30,
        key: (r) => String(r.id), got: (await ask("/api/admin/actions", ck)).json?.actions ?? [],
      });
      const five = await actionsOf(5);
      if (five.length === 5) {
        const got5 = (await ask("/api/admin/actions?limit=5", ck)).json?.actions ?? [];
        listCheck("审计日志（limit=5）", {
          want: five.map((r) => ({ ...r, __ord: String(r.__o) })), limit: 5,
          key: (r) => String(r.id), got: got5,
        });
      } else {
        skipped("审计日志（limit=5）", `审计只有 ${all30.length} 条，凑不出"前 5 是前 30 的前缀"这个宾语`);
      }
      // 非法 limit 落回默认，而不是 500 也不是把 SQL 打挂
      const defaultLen = ((await ask("/api/admin/actions", ck)).json?.actions ?? []).length;
      for (const bad of ["abc", "0", ""]) {
        const gotBad = (await ask(`/api/admin/actions?limit=${bad}`, ck)).json?.actions ?? [];
        check(gotBad.length === defaultLen,
          `limit=${bad ? bad : "空串"} 落回默认 30 而不是报错`, `${gotBad.length} 行`);
      }
    }
    /* ⑧.7 资金流水：三段成交记录合并取最近 60
     *
     * 这里刻意**不**照抄实现的那条 UNION。三个原因：
     *   1) 复算的作用是实现出错时的独立证人，跟着抄一段 SQL 就等于让证人站在被告席上；
     *      这条 UNION 在两个活库上都会 ER_CANT_AGGREGATE_NCOLLATIONS（topup_orders 是
     *      0900_ai_ci 而 users/articles/series 是 unicode_ci），Node 那句因此一直
     *      被 catch 吞成空表——照抄的复算只会同样空，然后绿。
     *   2) 三段分开查、在 JS 里合并，合并规则（按 '%m-%d %H:%i' 字符串倒序、截 60）
     *      是这条读**真正的需求**，写出来才谈得上"从需求重算一遍"。
     *   3) 套餐名那张只有三档的表也是需求的一部分：第四档 studio 不在表里，
     *      于是那一档显示 pack_key 原文。分开查之后这条用一个对象写明，而不是藏在 SQL 里。
     */
    {
      const PACKS = { starter: "体验包", standard: "标准包", pro: "创作包" };
      const segs = [];
      segs.push((await rows(
        `SELECT o.pack_key AS pk, u.nickname AS user, o.points AS amount,
                DATE_FORMAT(o.paid_at,'%m-%d %H:%i') AS createdAt
           FROM topup_orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'paid'`))
        .map((r) => ({ kind: "充值", user: String(r.user), title: PACKS[r.pk] ?? String(r.pk),
          amount: Number(r.amount ?? 0), gain: 0, createdAt: String(r.createdAt) })));
      segs.push((await rows(
        `SELECT u.nickname AS user, a.title, ap.price AS amount, ap.author_gain AS gain,
                DATE_FORMAT(ap.created_at,'%m-%d %H:%i') AS createdAt
           FROM article_purchases ap JOIN users u ON u.id = ap.user_id JOIN articles a ON a.id = ap.article_id`))
        .map((r) => ({ kind: "单篇解锁", user: String(r.user), title: String(r.title),
          amount: Number(r.amount ?? 0), gain: Number(r.gain ?? 0), createdAt: String(r.createdAt) })));
      segs.push((await rows(
        `SELECT u.nickname AS user, s.title, sp.price AS amount, sp.author_gain AS gain,
                DATE_FORMAT(sp.created_at,'%m-%d %H:%i') AS createdAt
           FROM series_purchases sp JOIN users u ON u.id = sp.user_id JOIN series s ON s.id = sp.series_id`))
        .map((r) => ({ kind: "专栏打包", user: String(r.user), title: String(r.title),
          amount: Number(r.amount ?? 0), gain: Number(r.gain ?? 0), createdAt: String(r.createdAt) })));
      const merged = segs.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      const want = merged.slice(0, 60);
      const got = (await ask("/api/admin/orders", ck)).json?.orders ?? [];
      const norm = (r) => [String(r.kind), String(r.user), String(r.title), Number(r.amount ?? 0),
        Number(r.gain ?? 0), String(r.createdAt)].join("\u0002");
      const tally = (list) => {
        const m = new Map();
        for (const r of list) m.set(norm(r), (m.get(norm(r)) ?? 0) + 1);
        return m;
      };
      const gotT = tally(got);
      const allT = tally(merged);
      const windowT = tally(want);
      check(segs.flat().length > 0, "资金流水宾语存在（三张成交表里至少有一行）",
        `充值 ${segs[0].length} / 解锁 ${segs[1].length} / 打包 ${segs[2].length}`);
      check(got.length === want.length, "资金流水条数与复算一致", `期望 ${want.length} 实得 ${got.length}`);
      if (!want.length) {
        skipped("资金流水内容与复算一致", "三张表都没有成交行，没有宾语");
      } else {
        // 每一行都必须是真成交行（"多出一行"是资金面板最贵的一种错）
        const strays = [...gotT.keys()].filter((k) => !allT.has(k));
        check(strays.length === 0, "资金流水每一行都能在三张成交表里找到原型",
          strays.slice(0, 2).map((s) => s.split("\u0002").join("·")).join(" | "));
        const boundaryTie = merged.length > 60 && merged[59].createdAt === merged[60].createdAt;
        if (boundaryTie) {
          skipped("资金流水窗口与复算完全一致",
            "第 60/61 条同分钟，MySQL 不保证谁进窗口——只钉\"每一行都有原型\"");
        } else {
          const same = [...windowT.keys()].sort().join("\u0003") === [...gotT.keys()].sort().join("\u0003")
            && [...windowT.keys()].every((k) => windowT.get(k) === gotT.get(k));
          check(same, "资金流水逐行多重集合与复算一致（行可完全相同，按键比会假绿）",
            `${got.length} 行 / 构成 ${JSON.stringify(got.reduce((m2, r) => { m2[r.kind] = (m2[r.kind] ?? 0) + 1; return m2; }, {}))}`);
        }
        const times = got.map((r) => String(r.createdAt));
        check(times.every((t, i) => i === 0 || t <= times[i - 1]),
          "资金流水按 '%m-%d %H:%i' 字符串倒序（排序键不含年份，跨年会错排——既有口径）", `${times[0]} … ${times[times.length - 1]}`);
      }
    }
    /* ⑧.8 评论管理 */
    {
      const want = await rows(
        `SELECT c.id AS k, c.id, IFNULL(u.nickname, IFNULL(c.guest_nickname,'旅人')) AS author,
                a.slug AS articleSlug, a.title AS articleTitle, LEFT(c.content, 120) AS content,
                DATE_FORMAT(c.created_at,'%m-%d %H:%i') AS createdAt,
                DATE_FORMAT(c.created_at,'%Y-%m-%d %H:%i:%s') AS __o
           FROM comments c LEFT JOIN users u ON u.id = c.user_id JOIN articles a ON a.id = c.article_id
          ORDER BY c.created_at DESC LIMIT 60`);
      listCheck("评论管理", {
        want: want.map((r) => ({ ...r, __ord: String(r.__o) })), limit: 60,
        key: (r) => String(r.id), got: (await ask("/api/admin/comments", ck)).json?.comments ?? [],
      });
    }
    /* ⑧.9 大盘：一半是 SQL、一半是 JS 组装，所以组装规则要单独钉 */
    {
      const got = (await ask("/api/admin/insights", ck)).json ?? {};
      const day = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() - offset);
        return {
          d: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
          label: `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`,
        };
      };
      const axis = Array.from({ length: 14 }, (_, i) => day(13 - i));
      const countsOf = async (table) => {
        const m = new Map();
        for (const r of await rows(
          `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') d, COUNT(*) c FROM ${table}
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) GROUP BY d`)) {
          m.set(String(r.d), Number(r.c));
        }
        return m;
      };
      const [byArt, byUser, byCmt] = [await countsOf("articles"), await countsOf("users"), await countsOf("comments")];
      const wantDays = axis.map((x) => ({
        d: x.d, label: x.label,
        articles: byArt.get(x.d) ?? 0, users: byUser.get(x.d) ?? 0, comments: byCmt.get(x.d) ?? 0,
      }));
      check(JSON.stringify(got.days ?? []) === JSON.stringify(wantDays),
        "大盘 14 天轴：日期、label 与三条计数全等",
        `末格 期望 ${brief(wantDays[13])} 实得 ${brief((got.days ?? [])[13])}`);

      const tipTotal = await num(`SELECT IFNULL(SUM(amount),0) FROM article_tips`);
      const wantInk = {
        tipCount: await num(`SELECT COUNT(*) FROM article_tips`),
        tipTotal,
        authorGot: Math.round(tipTotal * 0.9),
        topupCount: await num(`SELECT COUNT(*) FROM topup_orders WHERE status='paid'`),
        topupTotal: await num(`SELECT IFNULL(SUM(points),0) FROM topup_orders WHERE status='paid'`),
        qaCount: await num(`SELECT COUNT(*) FROM agent_qa`),
      };
      check(JSON.stringify(got.ink ?? {}) === JSON.stringify(wantInk),
        "大盘墨水经济六项与复算全等（authorGot = tipTotal×0.9 四舍五入）",
        `期望 ${brief(wantInk)} 实得 ${brief(got.ink)}`);

      const wantTop = await rows(
        `SELECT a.slug, a.title, IFNULL(u.nickname,'佚名') AS author, IFNULL(a.read_count,0) AS readCount,
                IFNULL(a.like_count,0) AS likeCount,
                IFNULL((SELECT SUM(amount) FROM article_tips t WHERE t.article_id = a.id), 0) AS tipTotal,
                a.read_count AS __o
           FROM articles a LEFT JOIN users u ON u.id = a.author_id
          WHERE a.status='published' AND a.review_status='approved'
          ORDER BY a.read_count DESC LIMIT 5`);
      listCheck("大盘热门榜", {
        want: wantTop.map((r) => ({ ...r, __ord: Number(r.__o) })), limit: 5,
        key: (r) => r.slug, got: got.topArticles ?? [],
      });

      const counter = new Map();
      for (const r of await rows(
        `SELECT CAST(tags AS CHAR) AS tags FROM articles
          WHERE status='published' AND review_status='approved' AND tags IS NOT NULL`)) {
        let list;
        try { list = JSON.parse(r.tags); } catch { continue; }
        if (!Array.isArray(list)) continue;
        for (const t of list.map(String)) counter.set(t, (counter.get(t) ?? 0) + 1);
      }
      const ranked = [...counter.entries()].map(([tag, count]) => ({ tag, count, __ord: count }))
        .sort((a, b) => b.count - a.count);
      listCheck("大盘标签构成", {
        want: ranked, limit: 8, key: (r) => r.tag, got: got.tags ?? [],
      });
    }
    } finally {
      /* 清场：夹具一律删除，并复核没有残留。删除放 finally 是因为"闸门自己崩了还把
       * 一行待审稿留在库里"会让下一次的内容管理判据莫名其妙多出一行。 */
      for (const id of made.reportIds) {
        await pool.query(`DELETE FROM reports WHERE id = ?`, [id]).catch(() => {});
      }
      for (const s of made.slugs) {
        await pool.query(`DELETE FROM articles WHERE slug = ?`, [s]).catch(() => {});
      }
      const leftReports = await num(`SELECT COUNT(*) FROM reports WHERE reason LIKE '闸门19夹具%'`);
      const leftArticles = await num(`SELECT COUNT(*) FROM articles WHERE slug LIKE 'p7f1e-fixture-%'`);
      check(leftReports === 0 && leftArticles === 0, "夹具已清干净（审核队列 / 举报里没有闸门留下的行）",
        `残留举报 ${leftReports} / 文章 ${leftArticles}`);
    }
  }
}

/* ⑨ 四个页面就地 SQL 的新家（P7f-1f-a）
 *
 * 这一族最特殊的不是它难算，而是它**原本不在任何判据的视野里**：SQL 直接写在 page.tsx 里，
 * 连 lib/data.ts 都不经过，所以闸门 18 的第一版一条也数不到；Node 侧又从来没有对应的路由，
 * 契约基线（闸门 1′）冻不出东西、对拍（闸门 1）没有宾语。裁判仍然只能是回库独立复算。
 *
 * 复算一律不抄实现的写法，否则两边共享同一个缺陷时"独立证人"就成了同案犯（P7f-1e 的教训）：
 *   · 九项计数按九句各自查（实现是一句九个子查询）；
 *   · 连签按**完整定义**走（实现是 400 行回溯 + 从昨天或今天往前数）；
 *   · '%m-%d %H:%i' 与 '%Y-%m-%d' 的格式化在 JS 里重做一遍（实现交给 DATE_FORMAT）。
 */
{
  const staff = ACTORS.test;
  const notStaff = ACTORS.writer ?? ACTORS.probe;
  const people = [["writer", ACTORS.writer], ["test", ACTORS.test], ["probe", ACTORS.probe]]
    .filter((pair) => pair[1]);

  const pad = (n) => String(n).padStart(2, "0");
  /** 本地日历日键（与 Node 页面当年那个 dayKey 同法：DATE 列按本地分量读回原样）。 */
  const localDay = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  /** '%m-%d %H:%i'——MySQL 那个格式串的 JS 版本。mysql2 按本地时区解析 DATETIME，取分量即原墙钟。 */
  const mmddhhmm = (v) => v instanceof Date
    ? `${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}`
    : String(v ?? "");

  /* ⑨.1 运营台总览：九项计数 + 最近问答。先证明门禁在，再比内容。 */
  {
    const guest = await ask("/api/admin/overview");
    check(guest.status === 401, `游客打 /api/admin/overview 必须 401，一个计数都不该给`, `status=${guest.status}`);
    const forged = await ask("/api/admin/overview", "ink_session=not-a-real-session");
    check(forged.status === 401, `伪造会话打 /api/admin/overview 同样 401`, `status=${forged.status}`);
    if (notStaff && staff && notStaff.id !== staff.id) {
      const r = await ask("/api/admin/overview", notStaff.cookie);
      check(r.status === 403, `非运营打 /api/admin/overview 是 403 而不是"少几条"`, `status=${r.status}`);
    }
  }
  if (staff) {
    const r = await ask("/api/admin/overview", staff.cookie);
    if (check(r.status === 200 && r.backend === "inkstack-java", "运营台总览由 Java 应答",
      `status=${r.status} backend=${r.backend || "无"}`)) {
      // 九句各自查，而不是把实现那"一句九个子查询"照抄一遍
      const want = {
        users: await num(`SELECT COUNT(*) FROM users`),
        articles: await num(`SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='approved'`),
        pending: await num(`SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='pending'`),
        comments: await num(`SELECT COUNT(*) FROM comments`),
        qa: await num(`SELECT COUNT(*) FROM agent_qa`),
        reports: await num(`SELECT COUNT(*) FROM reports WHERE status='open'`),
        tips: await num(`SELECT IFNULL(SUM(amount),0) FROM article_tips`),
        topup: await num(`SELECT IFNULL(SUM(points),0) FROM topup_orders WHERE status='paid'`),
        banned: await num(`SELECT COUNT(*) FROM users WHERE banned=1`),
      };
      const got = r.json?.stats ?? {};
      const wantKeys = Object.keys(want);
      check(JSON.stringify(Object.keys(got)) === JSON.stringify(wantKeys),
        "运营台九项计数的键集与键序都不许多也不缺", `实得 ${Object.keys(got).join(",")}`);
      const mism = wantKeys.filter((k) => Number(got[k]) !== want[k])
        .map((k) => `${k}: 期望 ${want[k]} 实得 ${got[k]}`);
      check(mism.length === 0, "运营台九项计数逐项与复算相等（九句各自查，不抄实现那句九子查询）",
        mism.slice(0, 3).join(" | ") || `${wantKeys.length} 项全等`);

      const qaRaw = await rows(`SELECT question, created_at,
              DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS ord FROM agent_qa
              ORDER BY created_at DESC LIMIT 8`);
      listCheck("运营台最近问答", {
        // 格式化在 JS 里重做：DATE_FORMAT 那个串由实现那边给，抄过来就等于让它自己证明自己
        want: qaRaw.map((x) => ({ question: String(x.question), createdAt: mmddhhmm(x.created_at), __ord: String(x.ord) })),
        limit: 8, key: (q) => `${q.question}|${q.createdAt}`, got: r.json?.recentQa ?? [],
      });
      if (!qaRaw.length) skipped("运营台最近问答有宾语", "库里一条问答都没有，比不出任何东西");
    }
  } else {
    skipped("运营台总览的内容判据", ".env 里没有运营账号（INK_TEST_*），拿不到 200 的应答");
  }

  /* ⑨.2 个人中心账号资料：五个字段逐个复算（含"印文留空回退昵称首字"那条默认值） */
  for (const [who, a] of people) {
    const r = await ask("/api/me/profile", a.cookie);
    if (!check(r.status === 200 && r.backend === "inkstack-java",
      `${who} 的账号资料由 Java 应答`, `status=${r.status} backend=${r.backend || "无"}`)) continue;
    const row = await only(`SELECT IFNULL(bio,'') AS bio, avatar_text AS avatarText,
              COALESCE(avatar_tone,'') AS avatarTone, COALESCE(avatar_shape,'') AS avatarShape,
              DATE_FORMAT(created_at,'%Y-%m-%d') AS createdAt FROM users WHERE id = ? LIMIT 1`, [a.id]);
    const sealRaw = row?.avatarText;
    const want = {
      bio: String(row?.bio ?? ""),
      // 与 PATCH /api/me/profile 写库那条同式：留空回退昵称首字（UTF-16 码元，emoji 会切半个）
      avatarText: sealRaw == null || sealRaw === "" ? String(a.nickname).slice(0, 1) : String(sealRaw),
      avatarTone: String(row?.avatarTone ?? ""),
      avatarShape: String(row?.avatarShape ?? ""),
      createdAt: String(row?.createdAt ?? "—"),
    };
    const got = r.json ?? {};
    check(JSON.stringify(Object.keys(got)) === JSON.stringify(Object.keys(want)),
      `${who} 的账号资料五个键、键序都不许多也不少`, `实得 ${Object.keys(got).join(",")}`);
    const mism = Object.entries(want).filter(([k, v]) => got[k] !== v)
      .map(([k, v]) => `${k}: 期望 ${brief(v)} 实得 ${brief(got[k])}`);
    check(mism.length === 0, `${who} 的账号资料逐字段与复算相等`, mism.slice(0, 3).join(" | "));
  }


  /* ⑨.2b 账号资料的"印文留空回退昵称首字"那条支路必须被证明走到了（P7f-1e 的教训：
   *      改错不红的判据等于一条没测过的支路）。三个固定账号的 avatar_text 都非空，
   *      正常跑进不去那条回退，所以临时把 probe 的印文清成**空串**，读完恢复原值。
   *
   *      为什么是空串而不是 NULL：schema.sql 里 avatar_text / avatar_tone / avatar_shape /
   *      created_at 全写的是 NOT NULL，把它置 NULL 会被数据库直接拒掉（第一版夹具就是这么崩的）。
   *      顺带记下两处**结构上不可达**的分支，别把它们当成"测过了"：实现与复算里那些
   *      COALESCE(...) 与 "—" 默认值只对"整行不存在"生效，而那一种需要拿一枚指向
   *      已删除用户的会话——本闸门刻意不造。 */
  {
    const a = ACTORS.probe;
    if (!a) {
      skipped("账号资料的印文回退支路", ".env 里没有 probe 账号（INK_PROBE_*），没有可临时改动的行");
    } else {
      const before = await only(`SELECT avatar_text FROM users WHERE id = ?`, [a.id]);
      try {
        await pool.query(`UPDATE users SET avatar_text = '' WHERE id = ?`, [a.id]);
        const r = await ask("/api/me/profile", a.cookie);
        const got = r.json ?? {};
        const first = String(a.nickname).slice(0, 1);
        check(r.status === 200 && got.avatarText === first,
          `印文为空串时确实回退成昵称首字「${first}」（这条支路走到了）`,
          `avatar_text='' → 实得 ${brief(got.avatarText)}`);
        check(got.avatarTone === "" && got.avatarShape === "",
          "印泥色 / 印式为空串时就是空串，不是 \"null\" 也不是占位符",
          `实得 ${brief(got.avatarTone)} 与 ${brief(got.avatarShape)}`);
      } finally {
        await pool.query(`UPDATE users SET avatar_text = ? WHERE id = ?`, [before?.avatar_text ?? "墨", a.id]);
        const after = await only(`SELECT avatar_text FROM users WHERE id = ?`, [a.id]);
        check(String(after?.avatar_text ?? "") === String(before?.avatar_text ?? ""),
          "夹具已恢复（probe 的印文回到改动前）",
          `改前 ${brief(before?.avatar_text ?? null)} 改后 ${brief(after?.avatar_text ?? null)}`);
      }
    }
  }

  /* ⑨.3 墨水账户四块：余额 / 今日额度是否已发 / 连签 / 流水 20 条 */
  for (const [who, a] of people) {
    const r = await ask("/api/me/points", a.cookie);
    if (!check(r.status === 200 && r.backend === "inkstack-java",
      `${who} 的墨水账户由 Java 应答`, `status=${r.status} backend=${r.backend || "无"}`)) continue;
    const got = r.json ?? {};
    const balance = await num(`SELECT points_balance FROM users WHERE id = ?`, [a.id]);
    check(Number(got.balance) === balance, `${who}·余额与 users 表当前值相等`,
      `期望 ${balance} 实得 ${got.balance}`);

    const quota = await only(`SELECT DATE_FORMAT(last_quota_date,'%Y-%m-%d') AS d FROM users WHERE id = ?`, [a.id]);
    const wantDone = quota?.d != null && String(quota.d) === localDay(0);
    check(got.quotaDone === wantDone, `${who}·"今日 30 滴已入仓"与 last_quota_date 一致`,
      `last_quota_date=${brief(quota?.d ?? null)} 今天=${localDay(0)} 实得 ${got.quotaDone}`);

    const days = new Set((await rows(
      `SELECT DATE_FORMAT(checkin_date,'%Y-%m-%d') AS d FROM checkins WHERE user_id = ?`, [a.id]
    )).map((x) => x.d));
    let off = days.has(localDay(0)) ? 0 : days.has(localDay(1)) ? 1 : -1;
    let wantStreak = 0;
    while (off >= 0 && days.has(localDay(off))) { wantStreak++; off++; }
    check(Number(got.streak) === wantStreak, `${who}·连签与完整定义的走查相等`,
      `期望 ${wantStreak} 实得 ${got.streak}（签到行数 ${days.size}）`);

    // 流水按 id DESC——全序、没有并列，所以逐元素严格比，不需要并列放开
    const led = await rows(`SELECT delta, reason, DATE_FORMAT(created_at,'%m-%d %H:%i') AS at
       FROM point_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [a.id]);
    const wantLed = led.map((x) => ({ delta: Number(x.delta), reason: String(x.reason), at: String(x.at) }));
    if (!wantLed.length) {
      skipped(`${who} 的墨水流水逐条与复算相等`, "这个账号一条流水都没有，比不出任何东西");
    } else {
      check(JSON.stringify(got.ledger ?? []) === JSON.stringify(wantLed),
        `${who} 的墨水流水逐条与复算相等（20 条上限、格式、正负号）`,
        `期望 ${wantLed.length} 条 ${brief(wantLed[0])}｜实得 ${(got.ledger ?? []).length} 条 ${brief((got.ledger ?? [])[0])}`);
    }
  }

  /* ⑨.4 安全中心两块：留痕 20 条 + 两步验证开关 */
  for (const [who, a] of people) {
    const r = await ask("/api/security/overview", a.cookie);
    if (!check(r.status === 200 && r.backend === "inkstack-java",
      `${who} 的安全中心由 Java 应答`, `status=${r.status} backend=${r.backend || "无"}`)) continue;
    const got = r.json ?? {};
    const raw = await rows(`SELECT id, event, ip, detail, created_at,
            DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS ord FROM audit_logs
            WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [a.id]);
    listCheck(`${who} 的留痕`, {
      want: raw.map((x) => ({
        id: Number(x.id), event: String(x.event), ip: x.ip ?? null, detail: x.detail ?? null,
        created_at: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at ?? ""),
        __ord: String(x.ord),
      })),
      limit: 20, key: (x) => String(x.id), got: got.audits ?? [],
    });
    if (!raw.length) skipped(`${who} 的留痕有宾语`, "这个账号一条审计都没有");
    const totp = await num(`SELECT IFNULL(totp_enabled,0) FROM users WHERE id = ?`, [a.id]);
    check(got.totpEnabled === (totp === 1), `${who}·两步验证开关与 users.totp_enabled 一致`,
      `totp_enabled=${totp} 实得 ${got.totpEnabled}`);
  }

  /* ⑨.5 这一族自己也得有"支路走到了"的证据：三个身份里至少要有一个拿得到留痕，
   *      否则上面那四条 listCheck 会全部空集通过（P7f-1e 被这类假绿咬过一次）。 */
  {
    const any = await num(`SELECT COUNT(*) FROM audit_logs
      WHERE user_id IN (${people.map(() => "?").join(",")})`, people.map(([, a]) => a.id));
    check(people.length === 0 || any > 0, "留痕判据有宾语（三个身份里至少一条审计）",
      people.length ? `${people.length} 个身份共 ${any} 条` : "没有任何身份可登录");
  }
}


/* ⑩ 渲染层最后 4 条的新家（P7f-1f-b）：会话、设备列表、外链白名单、每日额度
 *
 * 这一族与前面九个不是一回事：它们不是某个页面就地写的 SQL，而是住在**全站共用**的 lib 里——
 * `getCurrentUser` 每个已登录页面都要走两遍（报头一遍、页面一遍），`grantDailyQuota` 更是
 * 渲染时直接发生的一次**写**。交出去之后，"我是谁"只由 Java 判定，"今日 30 滴"只由
 * GET /api/auth/me 一处发放。
 *
 * 宾语也跟着换了，所以这一节不比数值为主：
 *   · ⑩.1 比的是**认人**：游客 / 伪造 / 三个真人各拿到什么，以及"换一个人问，答的就换一个人的 id"；
 *   · ⑩.1b 签有效、库里已吊销那一格必须落到游客——这是"双保险"里容易被省略的第二道；
 *   · ⑩.2 设备列表回库复算，"是不是本机"由闸门自己算 sha256(令牌) 判定，不抄实现；
 *   · ⑩.3 白名单必须挡住 pending / rejected。这份库里 approved 恰好是 0 条，
 *     于是三行夹具（approved / pending / rejected）就是这条判据的宾语——
 *     同一条记录要在审核队列里看得见、在放行清单里看不见，才叫真过滤过；
 *   · ⑩.4 是这一族里唯一的写，判据也得是写的判据：把当天置成"未发"再问，余额必须 +30、
 *     流水必须落一行；同一日再问一次必须一分不加。页面里那句 grantDailyQuota 删了以后，
 *     "到底还有没有人发"这一格由闸门 4 的渲染判据补（打到端点绿不代表页面会去打）。
 */
{
  const people = [["writer", ACTORS.writer], ["test", ACTORS.test], ["probe", ACTORS.probe]]
    .filter((pair) => pair[1]);
  const pad = (n) => String(n).padStart(2, "0");
  const localDay = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const iso = (v) => (v instanceof Date ? v.toISOString() : String(v ?? ""));
  const sha256 = (s) => createHash("sha256").update(s).digest("hex");
  const tokenOf = (cookie) => cookie.replace(/^ink_session=/, "");

  /* ⑩.1 会话解析：三方各拿到什么 */
  {
    const guest = await ask("/api/auth/me");
    check(guest.status === 200 && "user" in (guest.json ?? {}) && guest.json.user === null,
      "游客问 /api/auth/me 是 200 + user:null，不是 401、也不是少一个键",
      `status=${guest.status} 实得 ${brief(guest.json)}`);
    const forged = await ask("/api/auth/me", "ink_session=not-a-real-session");
    check(forged.status === 200 && (forged.json ?? {}).user === null,
      "伪造的 Cookie 同样只能拿到 user:null", `status=${forged.status} 实得 ${brief(forged.json)}`);
  }
  const ids = [];
  for (const [who, a] of people) {
    const r = await ask("/api/auth/me", a.cookie);
    const u = r.json?.user ?? null;
    if (!check(r.status === 200 && u !== null && r.backend === "inkstack-java",
      `${who} 问 /api/auth/me 由 Java 认出了人`, `status=${r.status} backend=${r.backend || "无"} user=${brief(u)}`)) continue;
    // 复算走的是"这枚令牌的哈希在库里对应的那个人"，与端点同一条链路但两句不同的 SQL
    const row = await only(`SELECT u.id, u.nickname, u.email, u.role, u.points_balance AS points
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > NOW() LIMIT 1`,
      [sha256(tokenOf(a.cookie))]);
    if (!check(!!row, `${who} 的这枚 Cookie 在 sessions 里确实是一条有效会话（双保险的第二道在场）`,
      `token_hash=${sha256(tokenOf(a.cookie)).slice(0, 12)}…`)) continue;
    check(JSON.stringify(Object.keys(u)) === '["id","nickname","email","role","points"]',
      `${who} 的会话应答只有那五个键，键序也不许多不少`, `实得 ${Object.keys(u).join(",")}`);
    const want = {
      id: Number(row.id), nickname: String(row.nickname), email: String(row.email),
      role: String(row.role), points: Number(row.points),
    };
    const mism = Object.entries(want).filter(([k, v]) => String(u[k]) !== String(v))
      .map(([k, v]) => `${k}: 期望 ${brief(v)} 实得 ${brief(u[k])}`);
    check(mism.length === 0, `${who} 的会话五个字段逐个与库里那行相等`,
      mism.slice(0, 3).join(" | ") || "五字段全等");
    if (Number(row.id) !== a.id) {
      check(false, `${who} 认出来的人就是登录的那一个`, `期望 ${a.id} 实得 ${row.id}`);
    }
    ids.push(Number(row.id));
  }
  if (ids.length >= 2) {
    check(new Set(ids).size === ids.length, "换一个人问，答的就换一个人的 id（不是把同一个人应答三遍）",
      `${ids.length} 个身份 → id ${ids.join(" / ")}`);
  } else {
    skipped("换一个人问就换一个人的 id", `只认出 ${ids.length} 个身份，比不出"换人"`);
  }

  /* ⑩.1b 第二道保险：签名依然有效，但库里已经吊销 → 必须是游客。
   *      做法是**再登一次**拿一枚新 Cookie（只改这一枚的库状态），于是"签有效 + 库里不通"
   *      这一格被单独钉住：少读一次 sessions 表也能全绿的实现，在这里一定会红。 */
  {
    const a = ACTORS.probe;
    let sid = 0;
    if (!a) {
      skipped("签名有效但库里已吊销那一格", ".env 里没有 probe 账号（INK_PROBE_*），没有可临时吊销的会话");
    } else {
      try {
        const cookie = await login(env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD);
        const h = sha256(tokenOf(cookie));
        const row = await only(`SELECT id, revoked FROM sessions WHERE token_hash = ? LIMIT 1`, [h]);
        if (!row) {
          check(false, "第二次登录在 sessions 里留下了行", "按 token_hash 查不到刚签的那条会话");
        } else {
          sid = Number(row.id);
          const before = await ask("/api/auth/me", cookie);
          if (check(before.status === 200 && before.json?.user?.id === a.id,
            "吊销之前这枚 Cookie 认得出人（否则下面的绿说不清是谁的功劳）", `实得 ${brief(before.json)}`)) {
            await pool.query(`UPDATE sessions SET revoked = 1 WHERE id = ?`, [sid]);
            const after = await ask("/api/auth/me", cookie);
            check(after.status === 200 && (after.json ?? {}).user === null,
              "库里已吊销 → 即使签名有效也只能是游客（第二道保险真的在挡）", `实得 ${brief(after.json)}`);
          }
        }
      } finally {
        if (sid) {
          await pool.query(`DELETE FROM sessions WHERE id = ?`, [sid]).catch(() => {});
          const left = await num(`SELECT COUNT(*) FROM sessions WHERE id = ?`, [sid]);
          check(left === 0, "夹具会话已清掉（闸门不在 sessions 表里留行）", `残留 ${left} 行`);
        }
      }
    }
  }

  /* ⑩.2 设备列表：与 sessions 表复算逐行比，外加"本机恰好一台" */
  {
    const guest = await ask("/api/security/sessions");
    check(guest.status === 401, `游客打 /api/security/sessions 必须 401，一台设备都不该给`, `status=${guest.status}`);
  }
  for (const [who, a] of people) {
    const r = await ask("/api/security/sessions", a.cookie);
    if (!check(r.status === 200 && r.backend === "inkstack-java",
      `${who} 的设备列表由 Java 应答`, `status=${r.status} backend=${r.backend || "无"}`)) continue;
    const mine = sha256(tokenOf(a.cookie));
    const raw = await rows(`SELECT id, ua, ip, token_hash AS tokenHash, created_at, last_seen_at,
            DATE_FORMAT(last_seen_at,'%Y-%m-%d %H:%i:%s') AS ord
       FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > NOW()
       ORDER BY last_seen_at DESC LIMIT 30`, [a.id]);
    const got = r.json?.sessions ?? [];
    listCheck(`${who} 的设备列表`, {
      want: raw.map((x) => ({
        id: Number(x.id), ua: x.ua ?? null, ip: x.ip ?? null,
        created_at: iso(x.created_at), last_seen_at: iso(x.last_seen_at),
        current: String(x.tokenHash) === mine, __ord: String(x.ord),
      })),
      limit: 30, key: (s) => String(s.id), got,
    });
    // "哪一台是本机"是一格布尔，不是排序副产物：只标当前这枚令牌，多标漏标都是错
    const marked = got.filter((s) => s.current === true).map((s) => String(s.id));
    const wantMarked = raw.filter((x) => String(x.tokenHash) === mine).map((x) => String(x.id));
    check(marked.length === 1 && marked[0] === wantMarked[0],
      `${who} 的设备列表里"本机"有且只有一台，且就是这枚令牌那一行`,
      `标了 ${brief(marked)}，应为 ${brief(wantMarked)}`);
    if (!raw.length) skipped(`${who} 的设备列表有宾语`, "这个账号当前没有有效会话行");
  }

  /* ⑩.3 外链放行清单：公开可取、只回 domain 一列、且必须过滤掉 pending / rejected */
  {
    const sorted = (list) => [...list].sort().join("\u0001");
    const approved = async () => (await rows(
      `SELECT domain FROM link_whitelist WHERE status = 'approved'`)).map((x) => String(x.domain).toLowerCase());
    const askDomains = async () => {
      const r = await ask("/api/links/allowed-domains");
      return { r, got: Array.isArray(r.json?.domains) ? r.json.domains : null };
    };

    const first = await askDomains();
    check(first.r.status === 200 && JSON.stringify(Object.keys(first.r.json ?? {})) === '["domains"]',
      "放行清单对游客可取，且应答里只有 domains 一个键（审核备注不许顺着这条公开路径漏出去）",
      `status=${first.r.status} 键 ${brief(Object.keys(first.r.json ?? {}))}`);
    const baseline = await approved();
    if (!baseline.length) {
      skipped("放行清单基线与库里的 approved 相等", `这份库当前 approved 是 0 条——下面的三行夹具才是这条判据的宾语`);
    } else {
      check(sorted(first.got ?? []) === sorted(baseline),
        `放行清单基线与库里的 ${baseline.length} 条 approved 一一对上`,
        `实得 ${brief((first.got ?? []).slice(0, 3))}`);
    }

    const FIX = [
      ["P7F1FB-Gate19-Approved.invalid.test", "approved"],
      ["p7f1fb-gate19-pending.invalid.test", "pending"],
      ["p7f1fb-gate19-rejected.invalid.test", "rejected"],
    ];
    try {
      for (const [d, s] of FIX) {
        await pool.query(`INSERT INTO link_whitelist (domain, url, note, status) VALUES (?, ?, ?, ?)`,
          [d, `https://${d.toLowerCase()}/`, "闸门19夹具", s]);
      }
      const { got } = await askDomains();
      const list = got ?? [];
      check(list.includes("p7f1fb-gate19-approved.invalid.test"),
        "approved 的那条确实进了放行清单，而且回的是小写（大写域名要能被比中）",
        `实得 ${brief(list.slice(-3))}`);
      check(!list.includes("p7f1fb-gate19-pending.invalid.test")
        && !list.includes("p7f1fb-gate19-rejected.invalid.test"),
        "pending 与 rejected 都不在放行清单里（status='approved' 这个过滤有宾语）",
        `清单 ${list.length} 条`);
      check(sorted(list) === sorted([...baseline, "p7f1fb-gate19-approved.invalid.test"]),
        "除了夹具那一条，其余就是库里的 approved——既不夹带默认的十几个代码站，也不吞掉真实条目",
        `期望 ${baseline.length + 1} 条 实得 ${list.length} 条`);
      /* 反方向的宾语：同一条 pending 必须在**审核队列**里看得见。
       * 少这一句，上面三条在"夹具根本没插进去"时也会全绿。 */
      const staff = ACTORS.test;
      if (!staff) {
        skipped("审核队列看得见那三条夹具", ".env 里没有运营账号（INK_TEST_*），拿不到 /api/links");
      } else {
        const q = await ask("/api/links", staff.cookie);
        const domains = (q.json?.links ?? []).map((l) => String(l.domain).toLowerCase());
        const missing = FIX.filter(([d]) => !domains.includes(d.toLowerCase())).map(([d]) => d);
        check(q.status === 200 && missing.length === 0,
          "那三条夹具在审核队列里三条都在（同表不同判据：队列全见、清单只见 approved）",
          missing.length ? `队列里缺 ${brief(missing)}` : `队列 ${domains.length} 条`);
      }
    } finally {
      await pool.query(`DELETE FROM link_whitelist WHERE note = '闸门19夹具'`).catch(() => {});
      const left = await num(`SELECT COUNT(*) FROM link_whitelist WHERE note = '闸门19夹具'`);
      check(left === 0, "白名单夹具已清干净", `残留 ${left} 行`);
      const back = await askDomains();
      check(sorted(back.got ?? []) === sorted(baseline),
        "清场之后放行清单回到基线（夹具没有被缓存在 Java 侧）",
        `期望 ${baseline.length} 条 实得 ${(back.got ?? []).length} 条`);
    }
  }

  /* ⑩.4 每日 30 滴：这一族里唯一的写，所以判据也是写的判据 */
  {
    const a = ACTORS.probe;
    if (!a) {
      skipped("每日额度的发放与判重", ".env 里没有 probe 账号（INK_PROBE_*），没有可安全改动的墨仓");
    } else {
      const before = await only(`SELECT points_balance AS bal, DATE_FORMAT(last_quota_date,'%Y-%m-%d') AS d,
              (SELECT IFNULL(MAX(id),0) FROM point_ledger) AS maxLedger
          FROM users WHERE id = ?`, [a.id]);
      const bal0 = Number(before.bal);
      try {
        // 先把"今天已经发过"这个既成事实抹掉：这是本闸门唯一一处**写夹具**，
        // 回滚按余额、日期、流水 id 三项精确复原，不靠"重放一遍业务"。
        await pool.query(`UPDATE users SET last_quota_date = DATE_SUB(CURDATE(), INTERVAL 3 DAY) WHERE id = ?`, [a.id]);
        const r = await ask("/api/auth/me", a.cookie);
        const after = await only(`SELECT points_balance AS bal, DATE_FORMAT(last_quota_date,'%Y-%m-%d') AS d
            FROM users WHERE id = ?`, [a.id]);
        check(Number(r.json?.user?.points) === bal0 + 30,
          "当天未发时，一次 GET /api/auth/me 就把 30 滴发出去（应答里带的也是发完之后的余额）",
          `余额 ${bal0} → 库里 ${after.bal}，应答 ${brief(r.json?.user?.points)}`);
        check(Number(after.bal) === bal0 + 30, `发放后余额恰好 +30`, `期望 ${bal0 + 30} 实得 ${after.bal}`);
        check(String(after.d) === localDay(0), "发放把 last_quota_date 记到今天（判重就靠这一列）",
          `实得 ${brief(after.d)} 今天 ${localDay(0)}`);
        const made = await rows(`SELECT delta, reason FROM point_ledger WHERE user_id = ? AND id > ?`,
          [a.id, Number(before.maxLedger)]);
        check(made.length === 1 && Number(made[0].delta) === 30 && String(made[0].reason) === "每日免费额度",
          "加出去的墨同时落了一条流水（账实相符）", `实得 ${brief(made)}`);

        const again = await ask("/api/auth/me", a.cookie);
        const second = await only(`SELECT points_balance AS bal FROM users WHERE id = ?`, [a.id]);
        const more = await num(`SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND id > ?`,
          [a.id, Number(before.maxLedger)]);
        check(Number(second.bal) === bal0 + 30 && more === made.length
          && Number(again.json?.user?.points) === bal0 + 30,
          "同一日再问一次一分都不再发（判重走的是 last_quota_date < 今天）",
          `余额 ${second.bal} 新增流水 ${more - made.length} 条`);
      } finally {
        await pool.query(`DELETE FROM point_ledger WHERE user_id = ? AND id > ? AND reason = '每日免费额度'`,
          [a.id, Number(before.maxLedger)]).catch(() => {});
        await pool.query(`UPDATE users SET points_balance = ?, last_quota_date = ? WHERE id = ?`,
          [bal0, before.d, a.id]).catch(() => {});
        const back = await only(`SELECT points_balance AS bal, DATE_FORMAT(last_quota_date,'%Y-%m-%d') AS d,
                (SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND id > ?) AS extra
            FROM users WHERE id = ?`, [a.id, Number(before.maxLedger), a.id]);
        check(Number(back?.bal) === bal0 && String(back?.d) === String(before.d) && Number(back?.extra) === 0,
          "额度夹具已回滚（余额、发放日、流水三项都回到改动前）",
          `余额 ${back?.bal}（原 ${bal0}）日期 ${brief(back?.d)}（原 ${brief(before.d)}）多余流水 ${back?.extra} 条`);
      }
    }
  }
}

await pool.end();
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ""}`);
process.exit(fail ? 1 : 0);
