#!/usr/bin/env node
// P5e 迁移工具闸门：POST /api/import 的 RSS 抓取 + Markdown 批量导入。
//
// 这条链路是全站**唯一一处「由用户给一个地址、服务端替他去联网」**的入口，所以它的洞不在算术，
// 而在两类：
//   1) SSRF：私网 / 环回 / 链路本地一律拒；重定向改手动、**每一跳重新过一遍同一套校验**。
//      写这道闸门时就抓到一处真实绕过：WHATWG 会把 [::ffff:192.168.1.2] 规范成 [::ffff:c0a8:102]，
//      于是「取 ::ffff: 之后那段字符串按 IPv4 判」拿到的是十六进制、正则不命中就当公网放行，
//      而操作系统照样把它当 IPv4 映射地址连出去（实测 200 命中本机网卡）。两侧现在都先解析成
//      **字节**再判，私网的七种写法（十进制 / 十六进制 / 八进制 / 短写 / 全角句号 / userinfo 掩护 /
//      IPv4 映射）必须落到同一条拒绝上。
//   2) 口径：那七条消毒正则、RFC 1123 的各家写法、DATETIME 的本地墙钟 + 毫秒四舍五入、
//      同名判重、slug 撞号换号、20 条上限。闸门让**两栈各导一轮**再逐列比库，
//      并且拿手推的期望产物断言「不是两栈一起错」。
//
//   node scripts/import-check.mjs            跑完清场
//   node scripts/import-check.mjs --keep     保留现场排查
//
// 前提：
//   ① 常规两栈已启动（Node 3200 / Java 3101），私网校验**开着**（默认即开）——第 1~3 节打这一对；
//   ② 另起一对「允许本机订阅源」的实例。不关黑名单就跑不通任何一次真实抓取，因为夹具必然落在
//      127.0.0.1 上（与 Node 的 IMPORT_ALLOW_PRIVATE 同一个开关，两侧都认）：
//        MSYS_NO_PATHCONV=1 NEXT_DIST_DIR=.next-importtest \
//          IMPORT_ALLOW_PRIVATE=1 node node_modules/next/dist/bin/next dev -p 3298
//        cd server && JAVA_HOME=<jdk17> mvn -o -s settings.xml spring-boot:run \
//          -Dspring-boot.run.arguments="--server.port=3198 --inkstack.import.allow-private=true"
//   ③ DATABASE_URL 指向**克隆库** inkstack_j：这道闸门会真建真删文章。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";
const ANODE = process.env.IMPORT_NODE || "http://localhost:3298";
const AJAVA = process.env.IMPORT_JAVA || "http://localhost:3198";
const KEEP = process.argv.includes("--keep");
const FIXTURE_PORT = Number(process.env.IMPORT_FIXTURE_PORT || 4599);
const FIX = `http://127.0.0.1:${FIXTURE_PORT}`;
/** 每轮换一个标记：上一轮 --keep 留下的同名行会把这一轮判成「重复导入」。 */
const MARK = String(Date.now());

let pass = 0;
let fail = 0;
let skip = 0;
function check(cond, label, detail) {
  const text = typeof detail === "function" ? detail()
    : typeof detail === "string" ? detail : (detail === undefined ? "" : JSON.stringify(detail));
  if (cond) {
    pass++;
    console.log(`PASS  ${label}${text ? "  — " + text : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}  — ${text || "（无细节）"}`);
  }
  return !!cond;
}
/** 需要外部条件（公网 / 本机网卡）才跑得动的探针：明确记 SKIP，绝不用 PASS 替它背书。 */
function skipped(label, why) {
  skip++;
  console.log(`SKIP  ${label}  — ${why}`);
}

const mysql = createRequire(import.meta.url)("mysql2/promise");
const conn = await mysql.createConnection(env.DATABASE_URL);
const only = async (sql, params = []) => (await conn.query(sql, params))[0][0] ?? null;
const many = async (sql, params = []) => (await conn.query(sql, params))[0];
const num = async (sql, params = []) => {
  const row = await only(sql, params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? 0 : Number(v);
};

async function call(base, method, url, body, cookie, opts = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload;
  if (body instanceof FormData) {
    payload = body; // 边界由 fetch 生成，这里绝不能自己写 content-type
  } else if (body !== undefined) {
    if (opts.contentType) h["content-type"] = opts.contentType;
    else h["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  } else if (opts.contentType) {
    h["content-type"] = opts.contentType;
  }
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res;
  try {
    res = await fetch(base + url, { method, headers: h, body: payload, signal });
  } catch (down) {
    return { status: 0, json: null, text: `${base} 连不上`, down: String(down?.message ?? down) };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 文本响应 */ }
  return { status: res.status, json, text, java: res.headers.get("x-backend") === "inkstack-java" };
}
async function login(base, email, password) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error(`${base} 登录失败 ${res.status}`);
  return cookie;
}
/** 同一个请求打两栈，只要「同状态同文案」：黑名单只看结论，不看谁先拒。 */
async function bothSame(url, cookie) {
  const [n, j] = await Promise.all([
    call(NODE, "POST", "/api/import", { url }, cookie),
    call(JAVA, "POST", "/api/import", { url }, cookie),
  ]);
  return { ok: n.status === j.status && (n.json?.error ?? n.text) === (j.json?.error ?? j.text), n, j };
}
async function refuse(label, url, cookie, wantStatus, wantError) {
  const r = await bothSame(url, cookie);
  return check(r.ok && r.n.status === wantStatus
    && (wantError === undefined || r.n.json?.error === wantError), label,
    () => `node=${r.n.status}/${r.n.json?.error ?? r.n.text.slice(0, 46)}`
      + ` java=${r.j.status}/${r.j.json?.error ?? r.j.text.slice(0, 46)}`);
}

/* ==================== 订阅源夹具 ==================== */

const HTML_BODY =
  '<p>第一段正文</p>'
  + '<script>alert(1)</script>'
  + '<SCRipt>alert(2)</SCRipt>'
  + '<iframe src="http://evil.example"></iframe>'
  + '<iframe src="http://evil2.example"/>'
  + '<object data="x"></object>'
  + '<embed src="y">'
  + '<style>body{color:red}</style>'
  + '<img src="a.png" onerror=alert(1)>'
  + '<div onclick="boom()">按钮</div>'
  + '<a href="javascript:alert(1)">旧链接</a>'
  + '<a HREF=\'JAVASCRIPT:alert(2)\'>另一个</a>';
/** 手推出来的期望产物：断言的是「两栈都得是这个」，不是「两栈一样就行」。 */
const SANITIZED_BODY =
  '<p>第一段正文</p><img src="a.png"><div>按钮</div>'
  + '<a href="#">旧链接</a><a HREF="#">另一个</a>';

const item = (title, body, pub, extra = "") =>
  `<item><title>${title}</title><description><![CDATA[${body}]]></description>`
  + (pub === undefined ? "" : `<pubDate>${pub}</pubDate>`) + extra + "</item>";

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>P5E 旧博客</title>
${item(`P5E Alpha ${MARK}`, HTML_BODY, "Mon, 23 Sep 2026 08:00:00 GMT")}
${item(`P5E Beta ${MARK}`, "<p>第二段</p>", "Mon, 12 Oct 2026 20:30:00 +0800")}
${item(`P5E Gamma ${MARK}`, "<p>没有日期的一段</p>")}
${item("", "<p>没有标题就被丢掉，且不进 skipped</p>")}
${item(`P5E Delta &amp; Co ${MARK}`, "<p>实体解码</p>", "Wed, 23 Sep 26 08:00:00 GMT")}
${item(`P5E Epsilon ${MARK}`, "<p>星期名不参与校验</p>", "Fri, 23 Sep 2026 08:00:00 GMT")}
<item><title>P5E Zeta ${MARK}</title><description>会被 content:encoded 顶掉</description>
<content:encoded><![CDATA[<p>真正的正文</p>]]></content:encoded>
<pubDate>Mon, 23 Sep 2026 08:00:00 GMT</pubDate></item>
${item("中文标题不带拉丁字母", "<p>兜底 slug 的一天</p>", "Mon, 23 Sep 2026 08:00:00 GMT")}
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>P5E Atom</title>
<entry><title>P5E Eta ${MARK}</title>
<summary type="html"><![CDATA[<p>没有 content 时 summary 顶上</p>]]></summary>
<updated>2026-09-23T08:00:00+08:00</updated></entry>
<entry><title>P5E Theta ${MARK}</title><content type="html"><![CDATA[<p>毫秒要四舍五入</p>]]></content>
<published>2026-09-23T08:00:00.700Z</published></entry>
</feed>`;

const KAPPA = `<?xml version="1.0"?><rss version="2.0"><channel><title>空格</title>`
  + item(`P5E Kappa ${MARK}`, "<p>Location 里有裸空格</p>") + "</channel></rss>";
const RACE = `<?xml version="1.0"?><rss version="2.0"><channel><title>撞 slug</title>`
  + item(`P5E Slug Race!! ${MARK}`, "<p>标题不同、slug 相同</p>") + "</channel></rss>";
const ONE_CN = `<?xml version="1.0"?><rss version="2.0"><channel><title>同名</title>`
  + item(`中文同名并发稿 ${MARK}`, "<p>并发导入撞 slug</p>", "Mon, 23 Sep 2026 08:00:00 GMT")
  + "</channel></rss>";
const MANY = `<?xml version="1.0"?><rss version="2.0"><channel><title>二十五条</title>`
  + Array.from({ length: 25 }, (_, i) =>
    item(`P5E Many ${String(i + 1).padStart(2, "0")} ${MARK}`, `<p>第 ${i + 1} 条</p>`)).join("")
  + "</channel></rss>";
const NO_ITEMS = `<?xml version="1.0"?><rss version="2.0"><channel><title>空</title></channel></rss>`;
const BIG = `<?xml version="1.0"?><rss version="2.0"><channel><title>大</title>`
  + item(`P5E Iota ${MARK}`, "<p>" + "x".repeat(2_100_000) + "</p>", "Mon, 23 Sep 2026 08:00:00 GMT")
  + "</channel></rss>";

const routes = {
  "/rss2": () => [200, "application/rss+xml", RSS2],
  "/atom": () => [200, "application/atom+xml", ATOM],
  "/many": () => [200, "application/rss+xml", MANY],
  "/same-name": () => [200, "application/rss+xml", ONE_CN],
  "/slugrace": () => [200, "application/rss+xml", RACE],
  "/empty": () => [200, "application/rss+xml", NO_ITEMS],
  "/big": () => [200, "application/rss+xml", BIG],
  "/notfound": () => [404, "text/plain", "没有这个订阅源"],
  "/hop1": () => [302, "", "", "/hop2"],
  "/hop2": () => [302, "", "", "/hop3"],
  "/hop3": () => [302, "", "", "/rss2"],
  "/loop": () => [302, "", "", "/loop"],
  "/noloc": () => [302, "", "", ""],
  "/jsredir": () => [302, "", "", "javascript:alert(1)"],
  "/spacey": () => [302, "", "", "/feed two.rss"],
  "/feed two.rss": () => [200, "application/rss+xml", KAPPA],
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/slow") {
    setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("太晚了"); }, 16_000);
    return;
  }
  const hit = routes[url]?.();
  if (!hit) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("夹具没有这条路径");
    return;
  }
  const [status, type, body, loc] = hit;
  const headers = {};
  if (type) headers["content-type"] = type;
  if (loc !== undefined) headers.location = loc;
  res.writeHead(status, headers);
  res.end(body || "");
});

/* ==================== 现场与清场 ==================== */

const FIXTURES = "(title LIKE 'P5E %' OR title LIKE '中文%' OR title = '未命名文章')";
const state = {};
async function wipeFixtures() {
  const ids = await many(`SELECT id FROM articles WHERE author_id=? AND ${FIXTURES}`, [state.writerId]);
  for (const row of ids) {
    for (const t of ["article_boosts", "article_tips", "article_likes", "bookmarks",
      "read_history", "comments", "series_items", "article_purchases"]) {
      await conn.query(`DELETE FROM ${t} WHERE article_id = ?`, [row.id]);
    }
  }
  if (ids.length) {
    await conn.query(`DELETE FROM articles WHERE author_id=? AND ${FIXTURES}`, [state.writerId]);
  }
  return ids.length;
}
async function cleanup() {
  const n = await wipeFixtures();
  const strays = await many("SELECT id FROM articles WHERE slug LIKE 'p5e-slug-race-%'");
  if (strays.length) await conn.query("DELETE FROM articles WHERE slug LIKE 'p5e-slug-race-%'");
  return n + strays.length;
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(FIXTURE_PORT, "127.0.0.1", resolve);
  });
  await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  server.close();
  if (Object.keys(state).length) {
    if (KEEP) {
      console.log("\n--keep：现场未清理");
    } else {
      try {
        console.log(`\n已清场：删除本次导入的 ${await cleanup()} 篇夹具文章`);
      } catch (e) {
        console.error("清场失败，克隆库可能残留测试数据：", e.message);
        fail++;
      }
    }
  }
  await conn.end().catch(() => {});
}
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ""}`);
process.exit(fail ? 1 : 0);

/* ==================== 用例主体 ==================== */

async function suit() {
  const writerId = await num("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]);
  if (!writerId) throw new Error("缺少 INK_WRITER_EMAIL 账号");
  Object.assign(state, { writerId });
  for (const [label, base] of [["Node", ANODE], ["Java", AJAVA]]) {
    const up = await call(base, "GET", "/api/articles?limit=1");
    if (up.status !== 200) {
      throw new Error(`未检测到「允许本机订阅源」的 ${label} 实例 ${base}（见本文件头部 ② 的启动命令）`);
    }
  }
  const writer = await login(NODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  const writerA = await login(ANODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);

  /**
   * 一次干净的导入：先清夹具行，只用**一个**栈导，再把库里的每一列抄回来。
   *
   * 两个栈往同一张表写，所以「比两栈产物」必须是各自独立的一轮——同一轮里读两次只是
   * 把同一行读了两遍，连「Java 把正文写坏了」这种最该报的都报不出来。
   */
  async function snapshot(base, url, form) {
    await wipeFixtures();
    const res = form !== undefined
      ? await call(base, "POST", "/api/import", form, writerA)
      : await call(base, "POST", "/api/import", { url }, writerA);
    const rows = await many(
      `SELECT title, slug, summary, md_content, cover_label, tags, status, review_status,
              DATE_FORMAT(published_at,'%Y-%m-%d %H:%i:%s') AS publishedAt
         FROM articles WHERE author_id=? AND ${FIXTURES} ORDER BY title, slug`, [writerId]);
    return { res, rows };
  }
  /** 源里没有日期的条目落的是「导入那一刻」，比对时抹掉，否则两轮永远差几秒。 */
  const VOLATILE = ["Gamma", "Kappa", "Slug Race", "未命名文章", "P5E md", "P5E Md", "Field", "Other"];
  const scrub = (rows) => rows.map((r) => ({
    ...r,
    publishedAt: VOLATILE.some((v) => r.title.includes(v)) ? "<此刻>" : r.publishedAt,
  }));
  const same = (a, b) => JSON.stringify(scrub(a)) === JSON.stringify(scrub(b));
  const dump = (rows) => JSON.stringify(scrub(rows)).slice(0, 420);
  /**
   * mysql2 把 Date 绑进 SQL 时用的是**驱动本地时区**的墙钟，而目标列是 DATETIME(0)，
   * MySQL 对多出来的小数秒做四舍五入。所以期望值必须按同一口径算：先按本地格式化，
   * 再把 ≥500 的毫秒进位到下一秒。
   */
  const localSql = (iso) => {
    let t = new Date(iso).getTime();
    const ms = new Date(t).getMilliseconds();
    if (ms >= 500) t += 1000 - ms;
    const d = new Date(t - new Date(t).getMilliseconds());
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  /* ---------- 1 请求姿势 ---------- */
  console.log("\n## 1 门禁与请求姿势：未登录、Content-Type、坏 JSON 是三条不同的 400");
  for (const [label, body, cookie, opts, want, text] of [
    ["未登录抓 RSS → 401", { url: `${FIX}/rss2` }, undefined, {}, 401,
      "登录后才能使用迁移工具（文章导入到你自己的账号）"],
    ["Content-Type 不认 → 另一条 400", "url=x", writer, { contentType: "text/plain" }, 400,
      "Content-Type 须为 application/json（RSS）或 multipart/form-data（Markdown）"],
    ["坏 JSON → 走覆盖整段解析的兜底，而不是「请求格式有误」", "{not json", writer,
      { contentType: "application/json" }, 400, "抓取/解析失败，请检查内容格式"],
    ["带 JSON 头却没有 body → 同一条兜底", undefined, writer,
      { contentType: "application/json" }, 400, "抓取/解析失败，请检查内容格式"],
    ["空对象 → 先判地址形状", {}, writer, {}, 400, "RSS 地址需以 http(s):// 开头"],
    ["url 是数字 → String() 之后仍不是 http(s)", { url: 123 }, writer, {}, 400,
      "RSS 地址需以 http(s):// 开头"],
    ["url 显式 null → 与空对象同一条", { url: null }, writer, {}, 400,
      "RSS 地址需以 http(s):// 开头"],
    ["体是数组 → 取不到 url 键，等价于没传", ["http://x"], writer, {}, 400,
      "RSS 地址需以 http(s):// 开头"],
  ]) {
    const [n, j] = await Promise.all([
      call(NODE, "POST", "/api/import", body, cookie, opts),
      call(JAVA, "POST", "/api/import", body, cookie, opts),
    ]);
    check(n.status === want && j.status === want && n.json?.error === text && j.json?.error === text,
      label, () => `node=${n.status}/${n.json?.error ?? n.text.slice(0, 46)}`
        + ` java=${j.status}/${j.json?.error ?? j.text.slice(0, 46)}`);
  }
  const [noMdN, noMdJ] = await Promise.all([
    call(NODE, "POST", "/api/import", new FormData(), writer),
    call(JAVA, "POST", "/api/import", new FormData(), writer),
  ]);
  check(noMdN.status === 400 && noMdJ.status === 400
    && noMdN.json?.error === "未收到 .md 文件" && noMdJ.json?.error === noMdN.json?.error,
    "multipart 里没有 files 字段 → 400「未收到 .md 文件」",
    () => `node=${noMdN.json?.error} java=${noMdJ.json?.error}`);
  const [noFileN, noFileJ] = await Promise.all([
    call(NODE, "POST", "/api/import", new FormData(), undefined),
    call(JAVA, "POST", "/api/import", new FormData(), undefined),
  ]);
  check(noFileN.status === 401 && noFileJ.status === 401
    && noFileN.json?.error === noFileJ.json?.error
    && noFileN.json?.error === "登录后才能使用迁移工具（文章导入到你自己的账号）",
    "未登录传 Markdown → 与抓 RSS 同一条 401（先判登录，再判 Content-Type）",
    () => `node=${noFileN.status}/${noFileN.json?.error} java=${noFileJ.status}/${noFileJ.json?.error}`);

  /* ---------- 2 私网 / 环回黑名单 ---------- */
  console.log("\n## 2 SSRF 黑名单：字面私网、名字黑名单、DNS 失败（校验开着，两侧同码同文案）");
  const PRIV = "禁止抓取内网/环回地址（安全防护）";
  const NAME = "禁止抓取内网/本机地址";
  const UNRESOLVED = "RSS 主机名无法解析，请确认地址可公开访问";
  for (const [url, text] of [
    [`${FIX}/rss2`, PRIV],
    ["http://10.1.2.3/rss2", PRIV],
    ["http://172.16.0.1/rss2", PRIV],
    ["http://172.31.255.255/rss2", PRIV],
    ["http://192.168.56.1/rss2", PRIV],
    ["http://169.254.169.254/latest/meta-data/", PRIV],
    ["http://100.64.0.1/rss2", PRIV],
    ["http://100.127.9.9/rss2", PRIV],
    ["http://0.0.0.0:4599/rss2", PRIV],
    ["http://[::1]:4599/rss2", PRIV],
    ["http://[fe80::1]/rss2", PRIV],
    ["http://[fd00::1234]/rss2", PRIV],
    ["http://localhost:4599/rss2", NAME],
    ["http://LOCALHOST:4599/rss2", NAME],
    ["http://ink.local/rss2", NAME],
    ["http://api.internal/rss2", NAME],
    ["http://nope.p5e.invalid/rss2", UNRESOLVED],
    ["http://127.0.0.1.p5e.invalid/rss2", UNRESOLVED],
  ]) {
    const kind = text === NAME ? "名字" : text === UNRESOLVED ? "解析失败" : "地址";
    await refuse(`${kind}：${url}`, url, writer, 400, text);
  }
  const subLocal = await bothSame("http://app.localhost:4599/rss2", writer);
  check(subLocal.ok && [PRIV, NAME, UNRESOLVED].includes(subLocal.n.json?.error),
    "子域 *.localhost 靠 DNS 解析结果兜住：两侧同结论且不放行",
    () => `node=${subLocal.n.json?.error} java=${subLocal.j.json?.error}`);

  /* ---------- 3 私网的七种写法 ---------- */
  console.log("\n## 3 同一个 127.0.0.1 的多种写法：归一化差一种，整条黑名单就失效");
  for (const url of [
    "http://2130706433:4599/rss2",
    "http://0x7f000001:4599/rss2",
    "http://0177.0.0.1:4599/rss2",
    "http://127.1:4599/rss2",
    "http://127。1:4599/rss2",
    "http://user@evil.example@127.0.0.1:4599/rss2",
    "http://[::ffff:127.0.0.1]:4599/rss2",
    "http://[::ffff:7f00:1]:4599/rss2",
    "  http://127.0.0.1:4599/rss2  ",
  ]) {
    await refuse(`归一化后仍被拒：${url}`, url, writer, 400, PRIV);
  }
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("127."))[0];
  if (lan) {
    const h = lan.address.split(".").map((p) => Number(p).toString(16).padStart(2, "0"));
    await refuse(`IPv4 映射（本机网卡 ${lan.address}）`,
      `http://[::ffff:${h[0]}${h[1]}:${h[2]}${h[3]}]:${FIXTURE_PORT}/rss2`, writer, 400, PRIV);
  } else {
    skipped("IPv4 映射（本机网卡）", "拿不到非环回 IPv4 网卡地址");
  }
  for (const url of ["https://not a url", "http://  http://127.0.0.1:4599/rss2",
    "http://256.1.1.1/rss2", "http://999999999999/rss2", "http://1.2.3.4:70000/rss2",
    "http://1.2.3.4:notaport/rss2", "http://[::ffff:1/rss2"]) {
    await refuse(`非法 URL：${url}`, url, writer, 400, "RSS 地址无法解析");
  }
  for (const url of ["ftp://127.0.0.1/rss2", "http://", "http:/127.0.0.1", "://127.0.0.1"]) {
    await refuse(`形状先判：${url}`, url, writer, 400, "RSS 地址需以 http(s):// 开头");
  }

  /* ---------- 4 抓取失败与重定向 ---------- */
  console.log("\n## 4 抓取失败分支：状态码、体积上限、逐跳上限都要两侧同文案");
  for (const [label, url, text] of [
    ["上游 404 → 带状态码的文案", `${FIX}/notfound`, "订阅源返回 404，请确认地址可公开访问"],
    ["空 feed → 明说没解析出文章", `${FIX}/empty`, "未在订阅源中解析出文章（支持 RSS 2.0 / Atom）"],
    ["响应体 >2MB 先拒，根本不进解析", `${FIX}/big`, "订阅源过大（>2MB），请精简后再试"],
    ["四跳即超限", `${FIX}/loop`, "订阅源跳转次数过多（>3 次），已拒绝"],
    ["302 没带 Location → 拒", `${FIX}/noloc`, "订阅源返回了无跳转目标的重定向（已拒绝）"],
    ["302 指向 javascript: → 拒", `${FIX}/jsredir`, "订阅源重定向到非 http(s) 地址（已拒绝）"],
    ["15 秒超时", `${FIX}/slow`, "订阅源抓取超时（15s）"],
  ]) {
    const [n, j] = await Promise.all([
      call(ANODE, "POST", "/api/import", { url }, writerA, { timeoutMs: 45_000 }),
      call(AJAVA, "POST", "/api/import", { url }, writerA, { timeoutMs: 45_000 }),
    ]);
    check(n.status === 400 && j.status === 400 && n.json?.error === text && j.json?.error === text,
      label, () => `node=${n.status}/${n.json?.error ?? n.text.slice(0, 46)}`
        + ` java=${j.status}/${j.json?.error ?? j.text.slice(0, 46)}`);
  }

  /* ---------- 5 两栈产物逐字段比对 ---------- */
  console.log("\n## 5 RSS 产物：两栈各导一轮，再逐列比库");
  const n5 = await snapshot(ANODE, `${FIX}/rss2`);
  const j5 = await snapshot(AJAVA, `${FIX}/rss2`);
  check(n5.res.json?.imported === 7 && j5.res.json?.imported === 7,
    "八条 item 入库七条：空标题那条被丢掉且**不进 skipped**",
    () => `node=${n5.res.json?.imported ?? n5.res.json?.error}`
      + ` java=${j5.res.json?.imported ?? j5.res.json?.error}`);
  check(n5.rows.length === 7 && j5.rows.length === 7 && same(n5.rows, j5.rows),
    "七篇的 title / slug / summary / md_content / tags / status / review_status / published_at 全部逐字段相等",
    () => dump(n5.rows) + "\n  vs " + dump(j5.rows));
  const alpha = n5.rows.find((r) => r.title.includes("Alpha"));
  if (check(!!alpha, "Alpha 那篇在")) {
    check(alpha.md_content === SANITIZED_BODY,
      "消毒产物**逐字**等于手推的期望结果（七条正则的顺序与产物）",
      () => JSON.stringify(alpha.md_content).slice(0, 200));
    check(!/script|iframe|object|embed|<style|onerror|onclick|javascript:/i.test(alpha.md_content),
      "危险构造一个都不剩", () => alpha.md_content.slice(0, 90));
    check(alpha.cover_label === "迁移" && alpha.status === "published"
      && alpha.review_status === "pending",
      "导入稿一律重新过审：published + pending + cover_label=迁移",
      () => `${alpha.status}/${alpha.review_status}/${alpha.cover_label}`);
    check(JSON.stringify(alpha.tags) === '["迁移"]', "tags 是 JSON.stringify([迁移])，非 ASCII 不转义", () => alpha.tags);
    check(alpha.summary.length <= 180 && !/\s\s/.test(alpha.summary) && /^\S/.test(alpha.summary),
      "摘要按 stripMd 把空白折成单空格且 ≤180", () => `len=${alpha.summary.length}`);
  }
  const zeta = n5.rows.find((r) => r.title.includes("Zeta"));
  check(zeta?.md_content === "<p>真正的正文</p>",
    "content:encoded 优先于 description", () => zeta?.md_content);
  const delta = n5.rows.find((r) => r.title.includes("Delta"));
  check(delta?.title === `P5E Delta & Co ${MARK}`,
    "标题里的 &amp; 解回 &", () => delta?.title);
  const gamma = n5.rows.find((r) => r.title.includes("Gamma"));
  check(!!gamma && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(gamma.publishedAt),
    "无 pubDate → published_at 兜底成导入时刻，不是 NULL", () => gamma?.publishedAt);
  const cn = n5.rows.find((r) => r.title.startsWith("中文标题"));
  const utcDay = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  check(cn?.slug === `bo-${utcDay}-7`,
    "中文标题回退到 bo-<UTC 日>-<序号>：日期取 UTC 日，序号只数成功入库的条数（被丢掉的空标题项不占号）",
    () => `${cn?.slug} 期望 bo-${utcDay}-7`);

  /* ---------- 6 日期口径 ---------- */
  console.log("\n## 6 日期：RFC 1123 各家写法都要落成同一个本地墙钟");
  for (const [who, iso, note] of [
    ["Alpha", "2026-09-23T08:00:00Z", "GMT"],
    ["Beta", "2026-10-12T12:30:00Z", "+0800"],
    ["Delta", "2026-09-23T08:00:00Z", "两位年 26 → 2026"],
    ["Epsilon", "2026-09-23T08:00:00Z", "星期名写错也照解析"],
    ["Zeta", "2026-09-23T08:00:00Z", "GMT + content:encoded"],
  ]) {
    const want = localSql(iso);
    const gotN = n5.rows.find((r) => r.title.includes(who))?.publishedAt;
    const gotJ = j5.rows.find((r) => r.title.includes(who))?.publishedAt;
    check(gotN === want && gotJ === want, `${who}（${note}）→ 库内 ${want}`,
      () => `node=${gotN} java=${gotJ}`);
  }

  /* ---------- 7 Atom、毫秒进位与逐跳重定向 ---------- */
  console.log("\n## 7 Atom 解析、毫秒进位与逐跳重定向");
  const n7 = await snapshot(ANODE, `${FIX}/atom`);
  const j7 = await snapshot(AJAVA, `${FIX}/atom`);
  check(n7.res.json?.imported === 2 && j7.res.json?.imported === 2 && same(n7.rows, j7.rows),
    "两条 entry 两栈各导一轮、逐字段相等",
    () => `node=${n7.res.json?.imported ?? n7.res.json?.error}`
      + ` java=${j7.res.json?.imported ?? j7.res.json?.error}`);
  const eta = n7.rows.find((r) => r.title.includes("Eta"));
  check(eta?.md_content === "<p>没有 content 时 summary 顶上</p>",
    "没有 content 时 summary 顶上（Atom 的第三种取值路径）", () => eta?.md_content);
  check(eta?.publishedAt === localSql("2026-09-23T08:00:00+08:00"),
    "Atom 的 ISO 带偏移日期 → 与 Node 同一个瞬间", () => eta?.publishedAt);
  const theta = n7.rows.find((r) => r.title.includes("Theta"));
  const wantTheta = localSql("2026-09-23T08:00:00.700Z");
  check(theta?.publishedAt === wantTheta
    && j7.rows.find((r) => r.title.includes("Theta"))?.publishedAt === wantTheta,
    "毫秒 .700 → DATETIME(0) 四舍五入进一秒，两侧同口径",
    () => `node=${theta?.publishedAt} java=${j7.rows.find((r) => r.title.includes("Theta"))?.publishedAt}`
      + ` 期望=${wantTheta}`);
  const n8 = await snapshot(ANODE, `${FIX}/hop1`);
  const j8 = await snapshot(AJAVA, `${FIX}/hop1`);
  check(n8.res.status === 200 && j8.res.status === 200 && n8.res.json?.source === "rss"
    && same(n8.rows, j8.rows),
    "三跳链条走完正常导入：redirect 是手动的，链子本身要能落库",
    () => `node=${n8.res.status}/${n8.res.json?.imported ?? n8.res.json?.error}`
      + ` java=${j8.res.status}/${j8.res.json?.imported ?? j8.res.json?.error}`);
  const n9 = await snapshot(ANODE, `${FIX}/spacey`);
  const j9 = await snapshot(AJAVA, `${FIX}/spacey`);
  check(n9.res.json?.imported === 1 && j9.res.json?.imported === 1 && same(n9.rows, j9.rows),
    "Location 里有裸空格 → 两侧都跟着跳到同一条路径（WHATWG 会 percent-encode）",
    () => `node=${n9.res.json?.imported ?? n9.res.json?.error}`
      + ` java=${j9.res.json?.imported ?? j9.res.json?.error}`);

  /* ---------- 8 入库规则 ---------- */
  console.log("\n## 8 入库：同名判重、slug 撞号换号、20 条上限与并发");
  const seeded = await snapshot(ANODE, `${FIX}/rss2`);
  check(seeded.res.json?.imported === 7, "先把七篇夹具导进来，作为判重与撞号的现场",
    () => `${seeded.res.json?.imported ?? seeded.res.json?.error}`);
  const reN = await call(ANODE, "POST", "/api/import", { url: `${FIX}/rss2` }, writerA);
  const reJ = await call(AJAVA, "POST", "/api/import", { url: `${FIX}/rss2` }, writerA);
  check(reN.json?.imported === 0 && reJ.json?.imported === 0
    && reN.json?.skipped?.length === 7 && reJ.json?.skipped?.length === 7
    && JSON.stringify(reN.json?.skipped) === JSON.stringify(reJ.json?.skipped)
    && reN.json?.skipped.every((s) => s.reason === "你的账号下已有同名文章"),
    "同一份源再导一次：七条全部「已有同名文章」，skipped 连顺序与键序都一致",
    () => `node=${JSON.stringify(reN.json?.skipped?.[0])} java=${JSON.stringify(reJ.json?.skipped?.[0])}`);
  await wipeFixtures();
  const manyN = await snapshot(ANODE, `${FIX}/many`);
  await wipeFixtures();
  const manyJ = await snapshot(AJAVA, `${FIX}/many`);
  check(manyN.res.json?.imported === 20 && manyJ.res.json?.imported === 20
    && manyN.rows.length === 20 && manyJ.rows.length === 20 && same(manyN.rows, manyJ.rows),
    "25 条只导前 20 条，且两栈导出的 20 条逐字段相同",
    () => `node=${manyN.res.json?.imported}/${manyN.rows.length}`
      + ` java=${manyJ.res.json?.imported}/${manyJ.rows.length}`);
  await wipeFixtures();
  await conn.query(
    `INSERT INTO articles (author_id, slug, title, md_content, summary, tags, status, review_status)
     VALUES (?, ?, ?, '占位', '', '["迁移"]', 'published', 'approved')`,
    [writerId, `p5e-slug-race-${MARK}`, `占位·不参与夹具清理 ${MARK}`]);
  const raceN = await snapshot(ANODE, `${FIX}/slugrace`);
  const raceJ = await snapshot(AJAVA, `${FIX}/slugrace`);
  check(raceN.res.json?.imported === 1 && raceN.rows.some((r) => r.slug === `p5e-slug-race-${MARK}-2`)
    && raceJ.rows.some((r) => r.slug === `p5e-slug-race-${MARK}-2`),
    "标题不同但 slug 撞唯一键 → 换号重试到 base-2，而不是「入库失败」",
    () => `node=${raceN.rows.map((r) => r.slug).join(",")} java=${raceJ.rows.map((r) => r.slug).join(",")}`);
  check(await num("SELECT COUNT(*) FROM articles WHERE slug = ?", [`p5e-slug-race-${MARK}`]) === 1,
    "换号重试没有覆盖占位那篇：base slug 仍然只有一行");
  await wipeFixtures();
  const conc = await Promise.all(Array.from({ length: 8 }, () =>
    call(ANODE, "POST", "/api/import", { url: `${FIX}/same-name` }, writerA)));
  const concRows = await many("SELECT slug FROM articles WHERE author_id=? AND title LIKE ?",
    [writerId, "中文同名并发稿%"]);
  check(conc.every((r) => r.status === 200),
    "8 路并发导入同一篇中文名文章：全部 200，零 500", () => conc.map((r) => r.status).join(","));
  const reported = conc.reduce((s, r) => s + (r.json?.imported ?? 0), 0);
  check(concRows.length === reported
    && new Set(concRows.map((r) => r.slug)).size === concRows.length,
    "并发落库的 slug 互不相同，且响应里报的篇数与库里的行数守恒（没丢稿也没合并）",
    () => `库 ${concRows.length} 篇 / 报 ${reported} 篇 / ${new Set(concRows.map((r) => r.slug)).size} 个 slug`);

  /* ---------- 9 Markdown 批量 ---------- */
  console.log("\n## 9 Markdown 批量：文件类型、体积、条数与标题/摘要口径");
  const mdForm = (entries) => {
    const fd = new FormData();
    for (const [name, text] of entries) fd.append("files", new Blob([text], { type: "text/markdown" }), name);
    return fd;
  };
  const MD_ENTRIES = [
    [`P5E-md-one-${MARK}.md`, `# P5E Md One ${MARK}\n\n> 引用首行不算段落\n\n这是第一段摘要来源。\n\n## 二级\n`],
    [`p5e_md_two_${MARK}_file-name.md`, "没有一级标题，用文件名兜底。\n\n正文在这里。"],
    ["P5E-md-bad.exe", "MZ\u0000\u0003"],
    ["P5E-md-empty.md", "  \n\t "],
  ];
  const n10 = await snapshot(ANODE, "", mdForm(MD_ENTRIES));
  const j10 = await snapshot(AJAVA, "", mdForm(MD_ENTRIES));
  check(n10.res.json?.imported === 2 && j10.res.json?.imported === 2
    && JSON.stringify(n10.res.json?.skipped) === JSON.stringify(j10.res.json?.skipped)
    && same(n10.rows, j10.rows),
    "四个文件：两篇入库、.exe 与空正文各自跳过，skipped 与产物逐字一致",
    () => `node=${JSON.stringify(n10.res.json?.skipped)} java=${JSON.stringify(j10.res.json?.skipped)}`);
  check(n10.res.json?.skipped?.[0]?.title === "P5E-md-bad.exe"
    && n10.res.json?.skipped?.[0]?.reason === "仅支持 .md/.markdown/.txt 且单文件 ≤300KB",
    "__SKIP__ 哨兵回吐原始文件名（slice(8)）而不是整串",
    () => JSON.stringify(n10.res.json?.skipped?.[0]));
  check(n10.res.json?.skipped?.[1]?.title === "P5E md empty"
    && n10.res.json?.skipped?.[1]?.reason === "标题或正文为空",
    "只有空白的 .md：文件名兜底出标题、理由是正文为空",
    () => JSON.stringify(n10.res.json?.skipped?.[1]));
  const mdOne = n10.rows.find((r) => r.title.includes("Md One"));
  check(mdOne?.summary === "引用首行不算段落",
    "firstParagraph 只跳标题/图片/列表符，引用块是被 stripMd 去掉 '>' 之后当首段的",
    () => mdOne?.summary);
  check(mdOne?.md_content === `# P5E Md One ${MARK}\n\n> 引用首行不算段落\n\n这是第一段摘要来源。\n\n## 二级`,
    "Markdown 原文只 trim 不改写（代码块里的 <script> 由渲染层转义）",
    () => JSON.stringify(mdOne?.md_content).slice(0, 140));
  const mdTwo = n10.rows.find((r) => r.slug.startsWith("p5e-md-two"));
  check(mdTwo?.title === `p5e md two ${MARK} file name`,
    "无一级标题时用文件名兜底：去扩展名、-/_ 换成空格", () => mdTwo?.title);
  const [bigN, bigJ] = await Promise.all([
    call(ANODE, "POST", "/api/import", mdForm([["P5E-md-huge.md", "x".repeat(300_001)]]), writerA),
    call(AJAVA, "POST", "/api/import", mdForm([["P5E-md-huge.md", "x".repeat(300_001)]]), writerA),
  ]);
  check(bigN.json?.skipped?.[0]?.reason === "仅支持 .md/.markdown/.txt 且单文件 ≤300KB"
    && JSON.stringify(bigN.json) === JSON.stringify(bigJ.json) && bigN.json?.imported === 0,
    "单文件超 300KB → 走文件类型那条文案跳过，不是 413",
    () => `node=${JSON.stringify(bigN.json?.skipped)} java=${JSON.stringify(bigJ.json?.skipped)}`);
  const tooMany = Array.from({ length: 21 }, (_, i) => [`P5E-many-${i}.md`, `# P5E Many F ${i}\n\n正文`]);
  const [tmN, tmJ] = await Promise.all([
    call(ANODE, "POST", "/api/import", mdForm(tooMany), writerA),
    call(AJAVA, "POST", "/api/import", mdForm(tooMany), writerA),
  ]);
  check(tmN.status === 400 && tmJ.status === 400
    && tmN.json?.error === "一次最多导入 20 个文件" && tmJ.json?.error === tmN.json?.error,
    "21 个文件 → 整单拒绝（不是收下 20 个）", () => `node=${tmN.json?.error} java=${tmJ.json?.error}`);
  const MIXED = [
    [`P5E-field-${MARK}.md`, `# P5E Field Only ${MARK}\n\n正文`, "files", "text/markdown"],
  ];
  const mixedForm = () => {
    const fd = new FormData();
    for (const [name, text] of MIXED) fd.append("files", new Blob([text], { type: "text/markdown" }), name);
    fd.append("files", "这不是文件");
    fd.append("other", new Blob([`# P5E Other ${MARK}\n\n正文`], { type: "text/markdown" }), "other.md");
    return fd;
  };
  await wipeFixtures();
  const mxN = await call(ANODE, "POST", "/api/import", mixedForm(), writerA);
  await wipeFixtures();
  const mxJ = await call(AJAVA, "POST", "/api/import", mixedForm(), writerA);
  check(mxN.json?.imported === 1 && mxJ.json?.imported === 1,
    "只收 files 字段下的真文件：同名字段的普通值、别的字段名的文件都不算",
    () => `node=${mxN.json?.imported ?? mxN.json?.error} java=${mxJ.json?.imported ?? mxJ.json?.error}`);
  await wipeFixtures();
  const untitledN = await snapshot(ANODE, "", mdForm([[".md", "正文没有标题"]] ));
  const untitledJ = await snapshot(AJAVA, "", mdForm([[".md", "正文没有标题"]])) ;
  check(untitledN.res.json?.imported === 1 && untitledJ.res.json?.imported === 1
    && untitledN.rows[0]?.title === "未命名文章" && untitledJ.rows[0]?.title === "未命名文章",
    "文件名为 .md 且无一级标题 → 兜底「未命名文章」",
    () => `node=${JSON.stringify(untitledN.rows[0]?.title)} java=${JSON.stringify(untitledJ.rows[0]?.title)}`);

  /* ---------- 10 跨栈互认 ---------- */
  console.log("\n## 10 一侧导入、另一侧读得懂");
  await wipeFixtures();
  const viaJava = await call(AJAVA, "POST", "/api/import", { url: `${FIX}/rss2` }, writerA);
  const slugRow = await only("SELECT slug FROM articles WHERE author_id=? AND title LIKE ?",
    [writerId, "P5E Alpha%"]);
  if (check(viaJava.status === 200 && !!slugRow, "Java 导一轮并且查得到 slug",
    () => `${viaJava.status}/${slugRow?.slug}`)) {
    const [rN, rJ] = await Promise.all([
      call(ANODE, "GET", `/api/articles/${encodeURIComponent(slugRow.slug)}`, undefined, writerA),
      call(AJAVA, "GET", `/api/articles/${encodeURIComponent(slugRow.slug)}`, undefined, writerA),
    ]);
    check(rN.status === rJ.status
      && (rN.json?.article?.md ?? null) === (rJ.json?.article?.md ?? null) && !!rN.json?.article?.md
      && rN.json?.article?.title === "P5E Alpha " + MARK,
      "Java 写进去的消毒正文，Node 的读接口原样读回",
      () => `node=${rN.status}/${rN.json?.article?.md?.slice(0, 26)}`
        + ` java=${rJ.status}/${rJ.json?.article?.md?.slice(0, 26)}`);
  }
  /**
   * 逐跳复校只有这一种跑法：首跳必须是**公网**地址，才能把"第二跳重新校验"这条路走到。
   * 离线时这一项记 SKIP 而不是 PASS——它是这道闸门里唯一一条环境相关的断言，
   * 也是那条"302 绕道云元数据"的严重级修复真正的行为证据。
   */
  if (process.env.IMPORT_PUBLIC_PROBE !== "0") {
    const redir = "https://httpbin.org/redirect-to?status_code=302&url="
      + encodeURIComponent(`${FIX}/rss2`);
    const r = await bothSame(redir, writer);
    if (r.n.status === 0) {
      skipped("公网首跳 302 到环回 → 逐跳复校", `公网不可达（${r.n.down.slice(0, 40)}）`);
    } else {
      check(r.ok && r.n.json?.error === PRIV,
        "公网首跳 302 到环回 → 第二跳被同一套校验拒掉",
        () => `node=${r.n.json?.error ?? r.n.text.slice(0, 60)} java=${r.j.json?.error ?? r.j.text.slice(0, 60)}`);
    }
  } else {
    skipped("公网首跳 302 到环回的逐跳复校", "IMPORT_PUBLIC_PROBE=0 显式关掉");
  }
}
