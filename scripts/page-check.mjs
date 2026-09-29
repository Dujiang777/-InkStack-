#!/usr/bin/env node
// 第四道闸门（P7e′ 改版）：页面渲染不变量 + "这一页真的在读这份库"的来源证明。
//
// 为什么不再是双轨对拍：以前这一道起两个实例——一个页面走 Node SQL、一个走 Java，
// 比读者真正看到的文本、链接与结构计数。P7e′ 把 Node 侧那 27 个读函数的 SQL 实现搬进
// lib/data-legacy.ts（只剩 app/api/** 在用）之后，页面只剩 Java 一条取数路，
// "两条路对拍"在结构上就不成立了——留着这个脚本比的是同一个执行者跟自己，必然全绿。
//
// 换成断言不是退而求其次，是补上了对拍**看不见**的那一格：双轨期两栈都错的话对拍照样绿，
// 而下面这些断言钉的是"页面必须长成什么样"，与另一套实现对不对着写无关。
// 最关键的一条是来源证明：JAVA_BASE 没配时页面会安静地渲染 lib/demo-data.ts 的演示文章，
// 200、有卡片、有正文，看起来完全正常——只有"首页列出的 slug 必须与库里公开文章的前 50 篇
// 一字不差"抓得住这种"渲染得很好但读的不是这份数据"。
//
//   node scripts/page-check.mjs                # 游客 + 三个身份，打 PARITY_NODE（默认 3200）
//   node scripts/page-check.mjs --login=writer
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
// 地址优先级：shell 环境变量 > .env > 默认。
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";
const argv = process.argv.slice(2);
const ONLY_LOGIN = (argv.find((a) => a.startsWith("--login=")) ?? "").slice(8) || null;
if (ONLY_LOGIN && !["test", "writer", "probe"].includes(ONLY_LOGIN)) {
  console.error("--login 只接受 test / writer / probe（凭据取自本地 .env）");
  process.exit(2);
}
const IDENTITIES = ONLY_LOGIN ? [ONLY_LOGIN] : [null, "test", "writer", "probe"];

let pass = 0;
let fail = 0;
let skip = 0;
function ok(label, detail = "") {
  pass++;
  console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
}
/** 判据没有宾语时记 SKIP 而不是 PASS：一条比不出东西的判据，绿了也不说明任何事。 */
function skipped(label, why) {
  skip++;
  console.log(`SKIP  ${label}  — ${why}`);
}
function bad(label, detail) {
  fail++;
  console.log(`FAIL  ${label}  — ${detail}`);
}
function check(cond, label, detail) {
  if (cond) ok(label, typeof detail === "string" ? detail : "");
  else bad(label, typeof detail === "string" ? detail : JSON.stringify(detail ?? ""));
  return cond;
}

/* ---------- 取渲染结果 ---------- */

async function render(p, cookie) {
  const res = await fetch(NODE + p, {
    headers: { "user-agent": "inkstack-page-check", ...(cookie ? { cookie } : {}) },
    cache: "no-store", redirect: "manual",
  });
  const html = res.status >= 300 && res.status < 400 ? "" : await res.text();
  return { status: res.status, location: res.headers.get("location") ?? "", html, shape: shape(html) };
}

/** 剥掉脚本/样式后的可见文本、按出现顺序的链接、以及几个结构计数。 */
function shape(html) {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const links = [...noScript.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => `${m[1]}|${m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}`);
  const text = noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const count = (sel) => (noScript.match(new RegExp(sel, "gi")) ?? []).length;
  return {
    text,
    links,
    slugs: [...new Set(links.map((l) => (l.match(/^\/article\/([^#?|]+)/) ?? [])[1]).filter(Boolean))]
      .map((s) => decodeURIComponent(s)),
    articleLinks: count(/href="\/article\//),
    headings: count(/<h[1-3]\b/),
    imgs: count(/<img\b/),
  };
}

async function loginCookie(id) {
  const creds = {
    test: [env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD],
    writer: [env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD],
    probe: [env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD],
  }[id];
  if (!creds || !creds[0] || !creds[1]) throw new Error(`.env 缺少 ${id} 的测试凭据`);
  const res = await fetch(NODE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: creds[0], password: creds[1] }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`登录失败：${JSON.stringify(body)}`);
  const cookie = (res.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0]).find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error("登录成功但没有 ink_session");
  return cookie;
}

/* ---------- 这份库的真相：来源证明要拿它当尺子 ---------- */
const mysql = (await import("mysql2/promise")).default;
const conn = await mysql.createConnection(env.DATABASE_URL);
const q = async (sql, args = []) => (await conn.query(sql, args))[0];

/** 重力排序的前 50 篇公开文章：首页列出的必须是它们，一篇都不能多（多出来的是演示数据或草稿）。 */
const gravityTop = await q(
  `SELECT a.slug FROM articles a JOIN users u ON u.id = a.author_id
    WHERE a.status = 'published' AND a.review_status = 'approved'
    ORDER BY a.pinned DESC,
      EXISTS(SELECT 1 FROM article_boosts b WHERE b.article_id = a.id AND b.boost_until > NOW()) DESC,
      (LOG10(a.read_count + a.comment_count * 5 + a.agent_qa_count * 10 + 10))
      / POWER(GREATEST(TIMESTAMPDIFF(HOUR, a.published_at, NOW()) + 2, 1), 1.2)
    DESC LIMIT 50`
).then((r) => r.map((x) => x.slug));
const gravitySet = new Set(gravityTop);
const publicSlugs = new Set(
  (await q(`SELECT slug FROM articles WHERE status='published' AND (review_status IS NULL OR review_status='approved')`))
    .map((r) => r.slug)
);
// 一篇免费正文文与一篇有定价的付费文：付费墙与正文渲染各有各的断言
const freeOne = (await q(
  `SELECT a.slug, a.title, u.nickname FROM articles a
     JOIN users u ON u.id = a.author_id
    WHERE a.status='published' AND a.review_status='approved' AND IFNULL(a.unlock_price,0) = 0
    ORDER BY a.id DESC LIMIT 1`))[0] ?? null;
// 付费文取**最后一行**：6 行试读绝不可能包含它，而取"中段"会连着行的 markdown 语法一起比，
// 换个渲染器就误报。要求全文 ≥ 10 行且末行 ≥ 12 字，是为了让这条断言真的在测"越界的那部分"。
const paidOne = (await q(
  `SELECT a.slug, a.title, u.nickname, IFNULL(a.unlock_price,0) AS price,
          SUBSTRING_INDEX(a.md_content, '\\n', -1) AS lastLine
     FROM articles a JOIN users u ON u.id = a.author_id
    WHERE a.status='published' AND a.review_status='approved' AND IFNULL(a.unlock_price,0) > 0
      AND (LENGTH(a.md_content) - LENGTH(REPLACE(a.md_content, '\\n', ''))) >= 9
      AND CHAR_LENGTH(SUBSTRING_INDEX(a.md_content, '\\n', -1)) >= 12
    ORDER BY a.id DESC LIMIT 1`))[0] ?? null;
/** 比正文片段前先归一：markdown 的 # * > - 与换行在渲染后都不存在，留着就是天天误报。 */
const plain = (s) => String(s ?? "").replace(/[#*>`\-_\s]+/g, "").trim();
const authorOne = (await q(
  `SELECT a.author_id AS id, u.nickname, COUNT(*) AS c FROM articles a
     JOIN users u ON u.id = a.author_id
    WHERE a.status='published' AND a.review_status='approved'
    GROUP BY a.author_id, u.nickname HAVING c >= 1 ORDER BY c DESC LIMIT 1`))[0] ?? null;
const seriesOne = (await q(
  `SELECT id, title FROM series WHERE author_id IS NOT NULL ORDER BY id LIMIT 1`))[0] ?? null;
const tagOne = (await q(
  `SELECT JSON_UNQUOTE(JSON_EXTRACT(tags, '$[0]')) AS t FROM articles
    WHERE status='published' AND review_status='approved' AND JSON_LENGTH(tags) > 0 LIMIT 1`))[0] ?? null;

console.log(`打的是 ${NODE}（页面取数），来源库 ${(await q("SELECT DATABASE() AS d"))[0].d}\n`);

/* ---------- 1. 来源证明：页面列出的文章就是这份库的前 50 篇 ---------- */
const guestHome = await render("/");
if (!check(guestHome.status === 200, "首页游客态 200", `实际 ${guestHome.status}${guestHome.location ? " → " + guestHome.location : ""}`)) {
  console.error("\n首页没能渲染，后面的断言无从判断，先停。");
  process.exit(1);
}
{
  const shown = guestHome.shape.slugs;
  const outside = shown.filter((s) => !gravitySet.has(s));
  check(shown.length >= 6 && outside.length === 0,
    "首页列出的文章全部出自这份库的重力序前 50（不是演示数据、不是草稿）",
    shown.length < 6 ? `只有 ${shown.length} 篇，页面像空壳` : `越界 ${outside.slice(0, 3).join(" ")}`);
  check(guestHome.shape.articleLinks >= 6 && guestHome.shape.text.length > 500,
    "首页不是空壳：文章链接数与可见文本都到位",
    `文章链接 ${guestHome.shape.articleLinks} 条，文本 ${guestHome.shape.text.length} 字`);
}

/* ---------- 2. 文章页：标题、作者、正文；付费文对游客必须挡住正文中段 ---------- */
if (freeOne) {
  const r = await render(`/article/${encodeURIComponent(freeOne.slug)}`);
  check(r.status === 200, "免费文章页游客态 200", String(r.status));
  check(r.shape.text.includes(String(freeOne.title)) && r.shape.text.includes(String(freeOne.nickname)),
    "免费文章页显示标题与作者昵称", `${freeOne.title} / ${freeOne.nickname}`);
  check(r.shape.text.length > 600, "免费文章页真的渲染了正文", `${r.shape.text.length} 字`);
} else bad("免费文章页", "库里找不到一篇免费公开文章，无法验正文渲染");

if (paidOne) {
  const r = await render(`/article/${encodeURIComponent(paidOne.slug)}`);
  const tail = plain(paidOne.lastLine);
  check(r.status === 200, "付费文章页游客态 200（不是 401/302）", String(r.status));
  check(r.shape.text.includes(String(paidOne.title)), "付费文章页对游客显示标题");
  check(tail.length >= 8 && !plain(r.shape.text).includes(tail),
    "付费文章对游客不漏末行正文", `末行「${String(paidOne.lastLine).slice(0, 18)}…」泄漏=${plain(r.shape.text).includes(tail)}`);
  check(new RegExp(String(paidOne.price)).test(r.shape.text),
    "付费文章的定价亮在页面上", `price=${paidOne.price}`);
} else bad("付费文章页", "库里找不到 10 行以上的有定价文章（付费墙这一格无从验，可跑 scripts/seed.mjs）");

/* ---------- 3. 作者页 / 话题页 / 专栏页：有内容、有对应实体 ---------- */
if (authorOne) {
  const r = await render(`/author/${authorOne.id}`);
  check(r.status === 200 && r.shape.text.includes(String(authorOne.nickname)),
    "作者页 200 且带作者昵称", `${r.status} ${authorOne.nickname}（文章 ${authorOne.c} 篇）`);
  check(r.shape.slugs.every((s) => publicSlugs.has(s)) && r.shape.slugs.length > 0,
    "作者页列出的文章都在公开集合里", `越池 ${r.shape.slugs.filter((s) => !publicSlugs.has(s)).length} 篇`);
}
if (tagOne && tagOne.t) {
  const r = await render(`/tag/${encodeURIComponent(tagOne.t)}`);
  check(r.status === 200 && r.shape.text.length > 200, "话题页 200 且有内容", `${r.status} 标签「${tagOne.t}」`);
}
if (seriesOne) {
  const r = await render(`/series/${seriesOne.id}`);
  check(r.status === 200 && r.shape.text.includes(String(seriesOne.title)),
    "专栏落地页 200 且带专栏标题", `${r.status} ${seriesOne.title}`);
}

/* ---------- 4. 登录门禁：游客的 /study 里不得出现别人的稿子 ---------- */
const writerTitles = (await q(
  `SELECT title FROM articles WHERE author_id = (SELECT id FROM users WHERE email = ?) LIMIT 5`,
  [env.INK_WRITER_EMAIL]
)).map((r) => String(r.title)).filter(Boolean);
{
  if (!writerTitles.length) bad("游客态 /study 不泄露他人稿子", `库里 ${env.INK_WRITER_EMAIL} 没有文章，这一格没有判据`);
  else {
    const g = await render("/study");
    const hits = writerTitles.filter((t) => g.status === 200 && g.shape.text.includes(t));
    check(hits.length === 0, "游客态 /study 不出现写作者的稿子标题",
      hits.length ? `泄露：${hits.slice(0, 2).join(" | ")}` : `${g.status}${g.location ? " → " + g.location : "（游客态本就无内容）"}`);
  }
}

/* ---------- 5. 登录态：三个身份各渲染一遍核心页，验"转发 Cookie 到了 Java" ---------- */
for (const id of IDENTITIES) {
  if (!id) continue;
  const cookie = await loginCookie(id);
  const home = await render("/", cookie);
  check(home.status === 200, `${id} 身份首页 200`);
  const study = await render("/study", cookie);
  const me = await render("/me", cookie);
  check(study.status === 200 && me.status === 200,
    `${id} 身份的书房与书房首页都 200`, `study=${study.status} me=${me.status}`);
  // 这一条是 Cookie 转发的证据：Java 解不出会话时 /study 会渲染成游客空态，
  // 与第 4 节"游客看不到别人的稿子"配成一对——两头都钉住，中间才不会是假绿。
  const mine = id === "writer" ? writerTitles.filter((t) => study.shape.text.includes(t)) : [];
  const identitySeen = id !== "writer" || mine.length > 0;
  check(study.status === 200 && study.shape.text.length > 300 && identitySeen,
    `${id} 身份的书房不是游客空态（ink_session 真的转发到了 Java）`,
    id === "writer" ? `${study.shape.text.length} 字，认出自己的稿子 ${mine.length} 篇` : `${study.shape.text.length} 字`);
  const rnd = await render("/random", cookie);
  check(rnd.status >= 300 && rnd.status < 400 && /^\/article\//.test(rnd.location.replace(/^https?:\/\/[^/]+/, "")),
    `${id} 身份 /random 307 到一篇文章`, `${rnd.status} → ${rnd.location || "无 location"}`);
}


/* ---------- 5b. 四个"就地 SQL 迁过来"的页面：读数必须真的落到 DOM 上 ----------
 *
 * 闸门 19 证明的是**端点算得对**；从端点到读者眼睛之间还剩一段接线：页面把 remote 的返回值
 * 接错一个 prop，十九道判据全绿而面板是空的。这四条读从来没有对岸，所以这一格只能在渲染层
 * 这边补——断言的是 DOM 里出现的那个数，不是 JSON 里的那个数。
 */
{
  const emails = {
    test: env.INK_TEST_EMAIL, writer: env.INK_WRITER_EMAIL, probe: env.INK_PROBE_EMAIL,
  };
  /** 分组符钉死 en-US：Java 侧的展示值钉的是同一个 locale，谁的运行时 locale 一变这条就该红，
   *  而不是跟着运行时一起改口径，把真差异抹平成"两边都绿"。 */
  const groupedUS = (v) => new Intl.NumberFormat("en-US").format(Number(v));

  /* 5b.1 运营台：顶部计数必须是库里的数，而且那块"演示数据"的牌子不能亮 */
  {
    const c = (await q(`SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='approved') AS approved,
            (SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='pending') AS pending,
            (SELECT COUNT(*) FROM comments) AS comments, (SELECT COUNT(*) FROM agent_qa) AS qa,
            (SELECT IFNULL(SUM(amount),0) FROM article_tips) AS tips,
            (SELECT IFNULL(SUM(points),0) FROM topup_orders WHERE status='paid') AS topup,
            (SELECT COUNT(*) FROM reports WHERE status='open') AS openReports`))[0];
    const html = (await render("/admin", await loginCookie("test"))).html;
    const plate = /演示数据/.test(html ?? "") ? "演示数据" : /实时数据/.test(html ?? "") ? "实时数据" : "没有牌子";
    check(plate === "实时数据", "运营台在配置齐全时打的是「实时数据」的牌子",
      plate === "实时数据" ? "牌子与下面八格互相印证" : `牌子上写的是「${plate}」——这一页没走到 Java`);
    /* 顶部八个格子按 DOM 顺序逐个比，而不是"页面上找得到这几个数吗"。
     * 第一版就是后者，反证时把 stats 整个换成兜底假数（128/342/…）它**照样绿**——
     * 因为库里的 users 恰好是 8，而页面上别处也有 8。一条"至少命中一个"的判据，
     * 宾语其实只有一个偶然撞上的数。逐个比之后那条假数路径必须红。
     * 后四格走 toLocaleString()，这里把分组符钉死 en-US：Java 侧的展示值钉的是同一个 locale，
     * 谁的运行时 locale 一变这条就该红，而不是跟着运行时一起改口径把差异抹平。 */
    const groupedUS = (v) => new Intl.NumberFormat("en-US").format(Number(v));
    const want = [c.users, c.approved, c.pending, c.comments, c.qa, c.tips, c.topup, c.openReports];
    const shown = [...(html ?? "").matchAll(/<span class="stat-no">([\s\S]*?)<\/span>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
    const mism = want.map((v, i) => ({ v: groupedUS(v), s: shown[i], i }))
      .filter((x) => x.v !== x.s);
    if (shown.length !== want.length) {
      bad("运营台顶部八格逐个等于库里的复算值", `DOM 里只有 ${shown.length} 个 stat-no，期望 ${want.length} 个`);
    } else {
      check(mism.length === 0, "运营台顶部八格逐个等于库里的复算值",
        mism.length ? mism.slice(0, 3).map((x) => `第 ${x.i + 1} 格 期望 ${x.v} 实得 ${x.s || "空"}`).join(" | ")
          : `八格全等：${shown.join(" / ")}`);
    }
  }

  for (const id of ["test", "writer", "probe"]) {
    if (!emails[id]) continue;
    const cookie = await loginCookie(id);
    const uid = (await q(`SELECT id FROM users WHERE email = ?`, [emails[id]]))[0]?.id;
    if (!uid) { bad(`${id} 的账号能在库里找到`, "登录成功但库里没有这一行"); continue; }

    /* 5b.2 个人中心：注册日必须由 Java 那道读带回来，格式 '%Y-%m-%d' */
    {
      const d = (await q(`SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS d FROM users WHERE id = ?`, [uid]))[0]?.d;
      const page = await render("/me", cookie);
      check(page.status === 200 && String(page.shape.text).includes(String(d)),
        `${id} 的 /me 渲染出真实的注册日`, `status=${page.status} 期望含 ${d}`);
    }

    /* 5b.3 墨仓：余额与最近一条流水的事由都要在页面上 */
    {
      const bal = (await q(`SELECT points_balance AS b FROM users WHERE id = ?`, [uid]))[0]?.b;
      const led = (await q(`SELECT reason FROM point_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [uid]))[0];
      const page = await render("/points", cookie);
      const shown = ((page.html ?? "").match(/<b class="p-balance">\s*([\d,]+)\s*<\/b>/) ?? [])[1] ?? "";
      // 余额位**不带千分位**（与运营台后四格不同，那是 toLocaleString 的），所以这里去逗号再比
      check(page.status === 200 && shown.replace(/,/g, "") === String(bal),
        `${id} 的 /points 把库里的余额渲染在余额位上`,
        `status=${page.status} 期望 ${bal} 实得 ${shown || "空"}`);
      if (!led) {
        skipped(`${id} 的 /points 渲染出最近一条流水的事由`, "这个账号一条流水都没有");
      } else {
        check(page.status === 200 && String(page.shape.text).includes(String(led.reason)),
          `${id} 的 /points 渲染出最近一条流水的事由`, `期望含「${led.reason}」`);
      }
    }

    /* 5b.4 安全中心：留痕要有内容，而且一个 Invalid Date 都不许有。
     *      后半条不是装饰——Node 侧那处"时间显示成 Invalid Date"的真 bug，就是靠它暴露的，
     *      而它当时照样 200、照样有内容。
     *      条数按 DOM 里渲染出来的 audit-tag 数比，而不是按事由文本比：组件把事件码翻成中文
     *      （login_ok → 「登录成功」那一类），拿库里的码去页面找字符串是一条永远对不上的路。 */
    {
      const recent = await q(
        `SELECT event FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [uid]);
      const page = await render("/security", cookie);
      check(page.status === 200 && !/Invalid Date/.test(String(page.shape.text)),
        `${id} 的 /security 没有 Invalid Date`, `status=${page.status}`);
      if (!recent.length) {
        skipped(`${id} 的 /security 渲染出留痕列表`, "这个账号没有审计记录");
      } else {
        const rendered = ((page.html ?? "").match(/<span class="audit-tag/g) ?? []).length;
        check(rendered === recent.length,
          `${id} 的 /security 把最近 ${recent.length} 条留痕一条条渲染出来了`,
          `DOM 里 ${rendered} 个 audit-tag，库里 ${recent.length} 条（含登录失败 ${recent.filter((r) => r.event === "login_fail").length} 条）`);
      }
    }
  }
}

/* ---------- 6. 漫游记的三条自证断言（每次抽不同文章，比逐字是假命题） ---------- */
{
  const DRAWS = 10;
  const seen = [];
  for (let i = 0; i < DRAWS; i++) {
    const r = await render("/random");
    const slug = r.status >= 300 && r.status < 400
      ? decodeURIComponent((r.location.replace(/^https?:\/\/[^/]+/, "").match(/^\/article\/([^#?]+)/) ?? [])[1] ?? "")
      : null;
    if (!slug) {
      bad(`/random 第 ${i + 1} 次没落到文章`, `status=${r.status} location=${r.location || "无"}`);
      continue;
    }
    seen.push(slug);
  }
  const distinct = new Set(seen);
  const leaks = [...distinct].filter((s) => !publicSlugs.has(s));
  check(leaks.length === 0, "随机池不越界：抽到的每篇都在公开列表里",
    leaks.length ? `越池 ${leaks.slice(0, 3).join(" ")}` : `${distinct.size} 篇全部在池内`);
  check(distinct.size >= 2, `${DRAWS} 次抽样出现过不止一篇`, `实际 ${distinct.size} 篇不同`);
}

/* ---------- 7. 搜索与归档：能列，且列出来的都在公开集合里 ---------- */
{
  const r = await render("/search?q=AI");
  check(r.status === 200 && r.shape.slugs.every((s) => publicSlugs.has(s)),
    "搜索页 200 且结果都在公开集合里", `结果 ${r.shape.slugs.length} 条`);
  const arch = await render("/archive");
  check(arch.status === 200 && arch.shape.slugs.length > 0
    && arch.shape.slugs.every((s) => publicSlugs.has(s)),
    "归档页 200 且文章都在公开集合里", `${arch.shape.slugs.length} 条`);
  const hot = await render("/hot");
  check(hot.status === 200 && hot.shape.slugs.every((s) => publicSlugs.has(s)),
    "热榜页 200 且不列草稿/未审稿", `${hot.shape.slugs.length} 条`);
  const ser = await render("/series");
  check(ser.status === 200, "专栏架 200", String(ser.status));
}

/* ---------- 8. 反向钉：Java 停了，页面必须 500 而不是悄悄改读别处 ---------- */
{
  const alive = await fetch(JAVA + "/api/articles?limit=1").then((r) => r.status).catch(() => 0);
  if (alive === 200) {
    ok("Java 在跑，页面取数问得到它", JAVA);
  } else {
    bad("Java 在跑，页面取数问得到它", `${JAVA} 不应答（${alive}）——这一道的来源证明依赖它`);
  }
}

await conn.end();
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项${skip ? `，另有 ${skip} 项因没有宾语记 SKIP` : ""}`);
process.exit(fail ? 1 : 0);
