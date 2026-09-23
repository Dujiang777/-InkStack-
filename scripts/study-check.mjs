#!/usr/bin/env node
// P5d 书房写侧闸门：草稿箱 / 阅读足迹 / 外链审核 / 个人资料 / 改密 / 上传 / 专栏增删改。
//
// 这一批的洞与前几批都不同，集中在三类：
//   1) 门禁的姿势不齐：友链的 GET/PUT 对游客回 **403 而不是 401**、足迹对游客回 **200 skipped**，
//      照搬时"顺手统一成 401"就是一次静默的接口变更。闸门逐条钉住姿势。
//   2) 字符串口径：草稿标题裁 200 但**不 trim**、内容**不 trim**、昵称要按 JS 的空白判据折叠，
//      一处 Java trim()/\s 就用错，两栈会各自存下"看着一样其实不一样"的昵称与草稿。
//   3) 整单语义：专栏重设篇目必须"要么全换要么不动"，混进一篇别人的稿子时不能先把柜子清空；
//      上传必须两栈写**同一个磁盘目录**，否则"上传成功、URL 回来了、图 404"。
//
//   node scripts/study-check.mjs          跑完把夹具与涉事账号复原
//   node scripts/study-check.mjs --keep   保留现场
//
// 前提：两栈已启动（Node 3200 / Java 3101），DATABASE_URL 指向**克隆库** inkstack_j。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";
const KEEP = process.argv.includes("--keep");

const TAG = "P5d 书房夹具";
const UPLOAD_DIR = path.join(root, "public", "uploads");
const START_MS = Date.now();
/**
 * 扫出本次运行产生的上传文件。文件名里就带着创建时刻的毫秒戳，所以按戳筛
 * 既能清干净、又不会误删更早的真实素材——只按 uploads 表清就会漏掉
 * "登记是 fire-and-forget、INSERT 落在查询之后"的那类孤儿文件。
 */
function sweepUploads(sinceMs) {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR).filter((f) => {
    const m = f.match(/^(d{13})-[0-9a-f]{8}.(png|jpg|gif|webp)$/);
    return m !== null && Number(m[1]) >= sinceMs;
  });
}

let pass = 0;
let fail = 0;
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

async function call(base, method, url, body, cookie, raw = false) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload;
  if (body instanceof FormData) {
    payload = body; // 边界由 fetch 生成，这里绝不能自己写 content-type
  } else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(base + url, { method, headers: h, body: payload });
  } catch (down) {
    return { status: 0, json: null, text: `${base} 连不上`, java: false, cd: "", ct: "" };
  }
  const text = await res.text();
  let json = null;
  if (!raw) { try { json = JSON.parse(text); } catch { /* 文本响应 */ } }
  return {
    status: res.status, json, text,
    java: res.headers.get("x-backend") === "inkstack-java",
    ct: res.headers.get("content-type") || "",
  };
}
/** 直接发一段原始 body：要测"坏 JSON"与"没有 body"，不能让 fetch 替我补上合法 JSON。 */
async function rawCall(base, method, url, body, cookie, type = "application/json") {
  const h = { ...(type ? { "content-type": type } : {}), ...(cookie ? { cookie } : {}) };
  const res = await fetch(base + url, { method, headers: h, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
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
const both = (method, url, body, cookie) => Promise.all([
  call(NODE, method, url, body, cookie), call(JAVA, method, url, body, cookie),
]);
/** 两侧同状态同文案。 */
async function sameBoth(label, method, url, body, cookie, want) {
  const [n, j] = await Promise.all([
    call(NODE, method, url, body, cookie), call(JAVA, method, url, body, cookie),
  ]);
  check(n.status === want && j.status === want && n.json?.error === j.json?.error,
    label, `${n.json?.error} / ${j.json?.error}`);
  return [n, j];
}
const keysOf = (o) => Object.keys(o ?? {}).join(",");

/** 一条只有本次用到的外链域名，跑完删掉。 */
let linkSeq = 0;
const freshDomain = () => `p5d-${Date.now()}-${linkSeq++}.example.com`;

const fixtures = [];
/**
 * 现场状态放在模块级：suit() 边跑边往里填，finally 无条件清场。
 *
 * <p>这不是风格问题——上一版把快照装在 suit() 的返回值里，一次 429 让用例在改密之后抛错，
 * finally 因为拿不到 ctx 直接跳过清场，结果**联调账号的密码被留在了测试值上**，
 * 下一轮连登录都进不去。会改走账号凭据的闸门，必须哪怕自己死了也能复原。
 */
const state = {};

try {
  await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  if (KEEP && Object.keys(state).length) {
    console.log("\n--keep：现场未清理");
  } else if (Object.keys(state).length) {
    try {
      await cleanup(state);
      console.log("\n已清场：草稿/足迹/外链/专栏/夹具文章/上传文件与涉事账号的资料、密码全部复原");
    } catch (e) {
      console.error("清场失败，克隆库可能残留测试数据：", e.message);
      fail++;
    }
  }
  await conn.end().catch(() => {});
}
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

/* ==================== 用例主体 ==================== */

async function suit() {
  const writerId = await num("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]);
  const probeId = await num("SELECT id FROM users WHERE email = ?", [env.INK_PROBE_EMAIL]);
  const adminId = await num("SELECT id FROM users WHERE email = ?", [env.INK_TEST_EMAIL]);
  if (!writerId || !probeId || !adminId) throw new Error("账号缺失");
  // 改密与资料用例都会真写库：先抄下原值，再登录——顺序反了就可能拿到被上一轮污染的快照
  const snap = await only("SELECT nickname, avatar_text, avatar_tone, avatar_shape, bio, password_hash FROM users WHERE id = ?", [writerId]);
  const mark = {
    draft: await num("SELECT IFNULL(MAX(id),0) FROM drafts"),
    link: await num("SELECT IFNULL(MAX(id),0) FROM link_whitelist"),
    history: await num("SELECT IFNULL(MAX(id),0) FROM read_history"),
    series: await num("SELECT IFNULL(MAX(id),0) FROM series"),
    upload: await num("SELECT IFNULL(MAX(id),0) FROM uploads"),
  };
  Object.assign(state, { writerId, probeId, adminId, snap, mark });
  const writer = await login(NODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  const probe = await login(NODE, env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD);
  const admin = await login(NODE, env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD);

  /* ---------- 1 门禁姿势 ---------- */
  console.log("\n## 1 门禁：姿势不一致是这批最容易改错的地方");
  const gates = [
    ["GET", "/api/drafts?title=x", undefined, 401, "未登录，草稿将暂存本地"],
    ["PUT", "/api/drafts", { title: "x", content: "y" }, 401, "未登录，草稿将暂存本地"],
    ["POST", "/api/links", { url: "https://example.com" }, 401, "登录后才能提交外链审核"],
    ["PATCH", "/api/me/profile", { nickname: "x" }, 401, "请先登录"],
    ["PATCH", "/api/me/password", { oldPassword: "a", newPassword: "b" }, 401, "请先登录"],
    ["POST", "/api/series", { title: "闸门专栏" }, 401, "登录后才能开专栏"],
    ["PATCH", "/api/series/1", { title: "闸门专栏" }, 401, "请先登录"],
    ["DELETE", "/api/series/1", undefined, 401, "请先登录"],
  ];
  for (const [method, url, body, want, text] of gates) {
    const [n, j] = await Promise.all([
      call(NODE, method, url, body, undefined), call(JAVA, method, url, body, undefined),
    ]);
    check(n.status === want && j.status === want && n.json?.error === text && j.json?.error === text,
      `未登录打 ${method} ${url} → ${want} 且两栈同文案`,
      `${n.status}/${j.status} ${n.json?.error} / ${j.json?.error}`);
  }
  // 游客上报足迹必须 **200 skipped**：这是埋点，回 401 只会在游客控制台里制造噪音
  const skipN = await call(NODE, "POST", "/api/history", { slug: "anything" }, undefined);
  const skipJ = await call(JAVA, "POST", "/api/history", { slug: "anything" }, undefined);
  check(skipN.status === 200 && skipJ.status === 200 && skipJ.json?.skipped === true
    && skipN.json?.skipped === true && skipJ.java === true,
    "游客 POST /api/history 两栈都回 200 skipped（不是 401）", JSON.stringify(skipJ.json));
  // 友链的 GET/PUT 反过来：游客吃 403，而且两栈都得是这个姿势
  for (const [method, url] of [["GET", "/api/links"], ["PUT", "/api/links"]]) {
    const [n, j] = await Promise.all([
      call(NODE, method, url, method === "PUT" ? { id: 1, action: "approve" } : undefined, probe),
      call(JAVA, method, url, method === "PUT" ? { id: 1, action: "approve" } : undefined, probe),
    ]);
    check(n.status === 403 && j.status === 403 && n.json?.error === j.json?.error
      && /^仅管理员/.test(String(j.json?.error)),
      `读者打 ${method} /api/links → 403（不是 401，也不是「管理团队」那套文案）`,
      `${n.json?.error} / ${j.json?.error}`);
  }
  const readerSeries = await call(JAVA, "POST", "/api/series", { title: "读者开的专栏" }, probe);
  check(readerSeries.status === 201 || readerSeries.status === 200,
    "读者（非运营）也能开专栏：这批接口不该卡角色", readerSeries.json);

  /* ---------- 2 草稿箱 ---------- */
  console.log("\n## 2 草稿箱：标题裁而内容不裁，读取按原始 query 判等");
  const dTitle = `${TAG}·草稿`;
  const dBody = "  带前导空格的正文  \n\n第二段。  ";
  const putN = await call(NODE, "PUT", "/api/drafts", { title: dTitle, content: dBody }, writer);
  const putJ = await call(JAVA, "PUT", "/api/drafts", { title: dTitle, content: dBody }, writer);
  check(putN.status === 200 && putJ.status === 200 && putJ.json?.ok === true
    && /^\d{2}:\d{2}:\d{2}$/.test(String(putJ.json?.savedAt)),
    "两栈存草稿都回 ok + HH:mm:ss 的 savedAt", putJ.json?.savedAt);
  const rows = await many("SELECT id, title, content FROM drafts WHERE user_id = ? AND title = ?",
    [writerId, dTitle]);
  check(rows.length === 1 && String(rows[0].content) === dBody,
    "同名 upsert 只留一行，且正文**不被 trim**（前导两个空格还在）",
    `${rows.length} 行 / ${JSON.stringify(String(rows[0]?.content)).slice(0, 30)}`);
  const readN = await call(NODE, "GET", `/api/drafts?title=${encodeURIComponent(dTitle)}`, undefined, writer);
  const readJ = await call(JAVA, "GET", `/api/drafts?title=${encodeURIComponent(dTitle)}`, undefined, writer);
  check(readN.json?.draft?.content === dBody && readJ.json?.draft?.content === dBody
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(readJ.json?.draft?.updatedAt))
    && keysOf(readJ.json?.draft) === "content,updatedAt",
    "跨栈读回同一份正文，updatedAt 是 SQL 侧格式化的串", `keys=${keysOf(readJ.json?.draft)}`);
  // Java 侧新存、Node 侧读出——这条链路断了就是"自动保存在一边生效"
  const cross = await call(JAVA, "PUT", "/api/drafts", { title: `${TAG}·跨栈`, content: "Java 写的草稿" }, writer);
  const crossRow = await only("SELECT content FROM drafts WHERE user_id = ? AND title = ?",
    [writerId, `${TAG}·跨栈`]);
  const crossRead = await call(NODE, "GET", `/api/drafts?title=${encodeURIComponent(`${TAG}·跨栈`)}`, undefined, writer);
  check(cross.status === 200 && crossRow?.content === "Java 写的草稿"
    && crossRead.json?.draft?.content === "Java 写的草稿",
    "Java 存的草稿 Node 读得到（同一张表、同一个唯一键）");
  const blankTitle = await call(JAVA, "PUT", "/api/drafts", { title: "   ", content: "x" }, writer);
  const blankN = await call(NODE, "PUT", "/api/drafts", { title: "   ", content: "x" }, writer);
  check(blankTitle.status === 400 && blankN.status === 400
    && blankTitle.json?.error === "title 不能为空",
    "全空格标题被 trim 后判空 → 400（标题 trim、正文不 trim，两件事）", blankTitle.json?.error);
  const padded = await call(NODE, "PUT", "/api/drafts", { title: `  ${TAG}·两头空  `, content: "x" }, writer);
  const paddedRow = await only("SELECT title FROM drafts WHERE user_id = ? AND title = ?",
    [writerId, `${TAG}·两头空`]);
  check(padded.status === 200 && paddedRow?.title === `${TAG}·两头空`,
    "入库的标题是裁过两边的版本");
  const missHit = await call(JAVA, "GET", `/api/drafts?title=${encodeURIComponent("  " + TAG + "·两头空  ")}`, undefined, writer);
  check(missHit.status === 200 && missHit.json?.draft === null,
    "读取时 query 里的 title **不 trim**：带空格就打不中裁过的行（与 Node 同）", missHit.json?.draft);
  const noTitle = await call(JAVA, "GET", "/api/drafts", undefined, writer);
  check(noTitle.status === 200 && noTitle.json?.draft === null && "draft" in (noTitle.json ?? {}),
    "不带 title → {draft:null}，键必须在而不是省略", noTitle.text);
  const otherUser = await call(JAVA, "GET", `/api/drafts?title=${encodeURIComponent(dTitle)}`, undefined, probe);
  check(otherUser.status === 200 && otherUser.json?.draft === null,
    "别人的草稿读不到：WHERE 里带 user_id，不靠应用层判", otherUser.json);
  const tooLong = await call(JAVA, "PUT", "/api/drafts", { title: `${TAG}·超长`, content: "字".repeat(100_001) }, writer);
  const tooLongN = await call(NODE, "PUT", "/api/drafts", { title: `${TAG}·超长`, content: "字".repeat(100_001) }, writer);
  check(tooLong.status === 400 && tooLongN.status === 400
    && tooLong.json?.error === "草稿过长（上限 10 万字）",
    "正文超 10 万字两栈同 400 文案", `${tooLongN.json?.error} / ${tooLong.json?.error}`);

  /* ---------- 3 阅读足迹 ---------- */
  console.log("\n## 3 阅读足迹：slug 判据与「记不上也不报错」");
  // 靶子文章是本次新建的：足迹要断言"第一次记 1、第二次累到 2"，
  // 拿库里已有的文章当靶就得先删它的历史行——闸门不该吃掉真实数据。
  const target = (await fixture(writerId, "足迹靶")).slug;
  const times = async () => num(
    "SELECT read_times FROM read_history WHERE user_id = ? AND article_id = (SELECT id FROM articles WHERE slug = ?)",
    [probeId, target]);
  const h1 = await call(JAVA, "POST", "/api/history", { slug: target }, probe);
  const times1 = await times();
  const h2 = await call(NODE, "POST", "/api/history", { slug: target }, probe);
  const times2 = await times();
  check(h1.status === 200 && h2.status === 200 && times1 === 1 && times2 === 2,
    "Node 记的第二次阅读累加在 Java 记的那一行上（同唯一键，两栈共用）", `times ${times1} → ${times2}`);
  const ghost = await call(JAVA, "POST", "/api/history", { slug: "p5d-没有这篇" }, probe);
  const ghostRows = await num("SELECT COUNT(*) FROM read_history WHERE user_id = ? AND article_id = (SELECT IFNULL(MIN(id),0) FROM articles WHERE slug='p5d-没有这篇')", [probeId]);
  check(ghost.status === 200 && ghost.json?.ok === true && ghostRows === 0,
    "不存在的 slug：回 200 ok 但一行都不记（插入即 SELECT 文章 id 的写法）", ghost.json);
  const [badSlugN, badSlugJ] = await Promise.all([
    call(NODE, "POST", "/api/history", { slug: "x".repeat(201) }, probe),
    call(JAVA, "POST", "/api/history", { slug: "x".repeat(201) }, probe),
  ]);
  check(badSlugN.status === 400 && badSlugJ.status === 400 && badSlugN.json?.error === badSlugJ.json?.error,
    "slug 超 200 → 两栈同 400", `${badSlugN.json?.error} / ${badSlugJ.json?.error}`);
  const [numN, numJ] = await Promise.all([
    call(NODE, "POST", "/api/history", { slug: 12345 }, probe),
    call(JAVA, "POST", "/api/history", { slug: 12345 }, probe),
  ]);
  check(numN.status === 400 && numJ.status === 400 && numJ.json?.error === "参数无效",
    "slug 是数字也算没传：typeof === 'string' 这一句两栈都在", `${numN.json?.error} / ${numJ.json?.error}`);
  const before = await num("SELECT read_times FROM read_history WHERE user_id = ? AND article_id = (SELECT id FROM articles WHERE slug = ?)", [probeId, target]);
  const [padN, padJ] = await Promise.all([
    call(NODE, "POST", "/api/history", { slug: `  ${target}  ` }, probe),
    call(JAVA, "POST", "/api/history", { slug: `  ${target}  ` }, probe),
  ]);
  const after = await num("SELECT read_times FROM read_history WHERE user_id = ? AND article_id = (SELECT id FROM articles WHERE slug = ?)", [probeId, target]);
  check(padN.status === 200 && padJ.status === 200 && after === before + 2,
    "带空格的 slug 先 trim 再查：状态码都是 200 并不能说明什么，行数才说明它命中了",
    `read_times ${before} → ${after}`);

  /* ---------- 4 外链审核 ---------- */
  console.log("\n## 4 外链：域名解析按 WHATWG，不按 java.net.URL");
  const cases = [
    ["https://www.Example.com/a?b=1", "example.com", 200],
    ["example.com", "example.com", 200],
    ["HTTP://WWW.Example.com/", "example.com", 200],
    ["https://user:pw@real.host/x", "real.host", 200],
    ["https://not a url", "", 400],
    ["https://", "", 400],
    ["", "", 400],
    ["https://exa mple.com/", "", 400],
    ["javascript:alert(1)", "", 400],
  ];
  for (const [url, domain, want] of cases) {
    const [n, j] = await Promise.all([
      call(NODE, "POST", "/api/links", { url }, writer),
      call(JAVA, "POST", "/api/links", { url }, writer),
    ]);
    check(n.status === want && j.status === want && n.json?.error === j.json?.error,
      `POST /api/links(${JSON.stringify(url).slice(0, 26)}) → ${want}`,
      `${n.status}/${j.status} ${j.json?.error ?? ""}`);
    if (want !== 200) continue;
    // 状态码一致还不够：真正要比的是"解析出来的域名是什么"。
    // java.net.URL 会把 "https://not a url" 的主机名当成 "not a url" 收下，正是这一条在挡它。
    // 域名是唯一的，直接按 domain 取。别按 id 水位取——上一轮中途异常留下的同名行
    // 水位之下，会被读成"这次根本没写进去"，于是闸门在别人的余烬上假失败。
    const stored = await many(
      "SELECT domain FROM link_whitelist WHERE domain = ?", [domain]
    );
    check(stored.length === 1 && stored[0].domain === domain,
      `  └ 解析结果入库为 ${domain}`, () => stored.map((r) => r.domain).join("|"));
  }
  const linkDomain = freshDomain();
  const submit = await call(JAVA, "POST", "/api/links", { url: `https://${linkDomain}/first`, note: "闸门首提" }, writer);
  const linkRow = await only("SELECT id, domain, url, note, status FROM link_whitelist WHERE domain = ?", [linkDomain]);
  check(submit.status === 200 && linkRow?.status === "pending" && linkRow?.note === "闸门首提"
    && linkRow?.url === `https://${linkDomain}/first`,
    "Java 投递的外链落 pending 并带上说明", JSON.stringify(linkRow));
  await call(NODE, "POST", "/api/links", { url: `https://${linkDomain}/second`, note: "换了一条" }, writer);
  const again = await only("SELECT url, note, status FROM link_whitelist WHERE domain = ?", [linkDomain]);
  check(again?.url === `https://${linkDomain}/second` && again?.note === "闸门首提"
    && again?.status === "pending",
    "同域名重复投递只刷 url，note 与 status 不动（ON DUPLICATE 只带 url 一列）", JSON.stringify(again));
  const links = await call(NODE, "GET", "/api/links", undefined, admin);
  const linksJ = await call(JAVA, "GET", "/api/links", undefined, admin);
  check(linksJ.status === 200 && linksJ.java === true && Array.isArray(linksJ.json?.links)
    && keysOf(linksJ.json?.links?.[0]) === "id,domain,url,note,status,createdAt"
    && linksJ.json.links.length === links.json.links.length,
    "两栈的待审列表行数一致、键序一致", `keys=${keysOf(linksJ.json?.links?.[0])}`);
  const ordered = (linksJ.json?.links ?? []).every((r, i, arr) => i === 0
    || String(arr[i - 1].status).localeCompare(String(r.status)) <= 0);
  check(ordered, "列表按 status 升序（pending 排在 approved 前面，队列才不会先看到已放行的）");
  await sameBoth("PUT /api/links 缺 action → 400", "PUT", "/api/links", { id: Number(linkRow.id) }, admin, 400);
  await sameBoth("PUT /api/links action 非法 → 400", "PUT", "/api/links",
    { id: Number(linkRow.id), action: "maybe" }, admin, 400);
  await sameBoth("PUT /api/links id 为 0 → 400（JS 假值判据）", "PUT", "/api/links",
    { id: 0, action: "approve" }, admin, 400);
  const appr = await call(NODE, "PUT", "/api/links", { id: Number(linkRow.id), action: "approve" }, admin);
  check(appr.status === 200 && (await only("SELECT status FROM link_whitelist WHERE id = ?", [linkRow.id]))?.status === "approved",
    "Node 放行生效");
  const rejec = await call(JAVA, "PUT", "/api/links", { id: Number(linkRow.id), action: "reject" }, admin);
  check(rejec.status === 200 && (await only("SELECT status FROM link_whitelist WHERE id = ?", [linkRow.id]))?.status === "rejected",
    "Java 驳回生效（跨栈改同一行）", rejec.json);
  const ghostLink = await call(JAVA, "PUT", "/api/links", { id: 99_999_999, action: "approve" }, admin);
  check(ghostLink.status === 200 && ghostLink.json?.ok === true,
    "审核不存在的 id 照样回 ok：Node 不判 affectedRows，行为照搬（并记在这里）", ghostLink.json);

  /* ---------- 5 个人资料 ---------- */
  console.log("\n## 5 资料：昵称按 JS 空白判据折叠，印文回退到昵称首字");
  const pFull = await call(JAVA, "PATCH", "/api/me/profile",
    { nickname: "张　　三", avatarText: "", avatarTone: "zhusha", avatarShape: "fang", bio: "  一句话简介  " }, writer);
  const pFullN = await call(NODE, "PATCH", "/api/me/profile",
    { nickname: "张　　三", avatarText: "", avatarTone: "zhusha", avatarShape: "fang", bio: "  一句话简介  " }, writer);
  check(pFull.status === 200 && pFullN.status === 200
    && pFull.json?.nickname === pFullN.json?.nickname && pFull.json?.nickname === "张 三",
    "两个全角空格的昵称两栈折成一个半角空格（Java 的 \\s 不认 U+3000，这里必须认）",
    `${pFullN.json?.nickname} / ${pFull.json?.nickname}`);
  const pRow = await only("SELECT nickname, avatar_text, avatar_tone, avatar_shape, bio FROM users WHERE id = ?", [writerId]);
  check(pRow?.nickname === "张 三" && pRow?.avatar_text === "张" && pRow?.avatar_tone === "zhusha"
    && pRow?.avatar_shape === "fang" && pRow?.bio === "一句话简介",
    "印文留空时按昵称首字兜底、简介裁两边后入库", JSON.stringify(pRow));
  check(pFull.json?.avatarText === "张" && pFull.json?.bio === "一句话简介"
    && keysOf(pFull.json) === "ok,nickname,avatarText,avatarTone,avatarShape,bio",
    "响应回的是清洗后的值（前端靠它立刻重绘印章），键序与 Node 相同", `keys=${keysOf(pFull.json)}`);
  const pBad = await call(JAVA, "PATCH", "/api/me/profile",
    { nickname: "李四", avatarTone: "hotpink", avatarShape: "hexagon" }, writer);
  check(pBad.status === 200 && pBad.json?.avatarTone === "" && pBad.json?.avatarShape === "",
    "不在色板/印式白名单里的值降级成空串（空串本身有意义：随缘派色 / 默认圆章）", pBad.json);
  const pEmpty = await call(NODE, "PATCH", "/api/me/profile", { nickname: "　　" }, writer);
  const pEmptyJ = await call(JAVA, "PATCH", "/api/me/profile", { nickname: "　　" }, writer);
  check(pEmpty.status === 400 && pEmptyJ.status === 400 && pEmptyJ.json?.error === "昵称不能为空",
    "纯全角空格的昵称算空 → 400（trim 判据两侧一致）", `${pEmpty.json?.error} / ${pEmptyJ.json?.error}`);
  const pBioNull = await call(JAVA, "PATCH", "/api/me/profile", { nickname: "王五", bio: "   " }, writer);
  const bioCol = await only("SELECT bio FROM users WHERE id = ?", [writerId]);
  check(pBioNull.status === 200 && pBioNull.json?.bio === "" && bioCol?.bio === null,
    "空简介入库是 NULL、响应却是空串（Node 的 bio || null 与 bio 两件事）", JSON.stringify(bioCol));
  const pLong = await call(JAVA, "PATCH", "/api/me/profile", { nickname: "名".repeat(30), bio: "简".repeat(200) }, writer);
  check(pLong.json?.nickname === "名".repeat(20) && pLong.json?.bio === "简".repeat(120),
    "昵称裁 20、简介裁 120，都是 UTF-16 码元口径", `${pLong.json?.nickname.length}/${pLong.json?.bio.length}`);
  const pZw = await call(NODE, "PATCH", "/api/me/profile", { nickname: "赵​六﻿" }, writer);
  const pZwJ = await call(JAVA, "PATCH", "/api/me/profile", { nickname: "赵​六﻿" }, writer);
  check(pZw.json?.nickname === pZwJ.json?.nickname && pZwJ.json?.nickname === "赵六",
    "零宽空格与 BOM 被清掉（昵称会进邮件 Subject，控制字符不能留）",
    `${JSON.stringify(pZw.json?.nickname)} / ${JSON.stringify(pZwJ.json?.nickname)}`);

  /* ---------- 6 上传 ---------- */
  console.log("\n## 6 上传：魔数说了算，两栈写同一个目录");
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xd, 0x49, 0x48, 0x44, 0x52]);
  const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0x3b]);
  const formWith = (buf, filename, type) => {
    const f = new FormData();
    f.append("file", new Blob([buf], { type }), filename);
    return f;
  };
  const upAnon = await Promise.all([
    call(NODE, "POST", "/api/uploads", formWith(PNG, "a.png", "image/png"), undefined),
    call(JAVA, "POST", "/api/uploads", formWith(PNG, "a.png", "image/png"), undefined),
  ]);
  check(upAnon.every((r) => r.status === 401 && r.json?.error === "登录后才能上传图片"),
    "匿名上传两栈都 401（不许因为「演示模式」之类的前置判断改变姿势）",
    upAnon.map((r) => r.status).join("/"));
  const [mimeN, mimeJ] = await Promise.all([
    call(NODE, "POST", "/api/uploads", formWith(PNG, "a.svg", "image/svg+xml"), writer),
    call(JAVA, "POST", "/api/uploads", formWith(PNG, "a.svg", "image/svg+xml"), writer),
  ]);
  check(mimeN.status === 415 && mimeJ.status === 415 && mimeJ.json?.error === "仅支持 png / jpg / gif / webp",
    "声明成 svg → 415（白名单在魔数之前判）", `${mimeN.json?.error} / ${mimeJ.json?.error}`);
  const [fakeN, fakeJ] = await Promise.all([
    call(NODE, "POST", "/api/uploads", formWith(GIF, "x.png", "image/png"), writer),
    call(JAVA, "POST", "/api/uploads", formWith(GIF, "x.png", "image/png"), writer),
  ]);
  check(fakeN.status === 415 && fakeJ.status === 415 && fakeJ.json?.error === "文件内容与声明类型不符",
    "GIF 内容伪装成 png → 415：改扩展名不能把可执行/HTML 载荷送进静态目录",
    `${fakeN.json?.error} / ${fakeJ.json?.error}`);
  const [tinyN, tinyJ] = await Promise.all([
    call(NODE, "POST", "/api/uploads", formWith(PNG.subarray(0, 8), "t.png", "image/png"), writer),
    call(JAVA, "POST", "/api/uploads", formWith(PNG.subarray(0, 8), "t.png", "image/png"), writer),
  ]);
  check(tinyN.status === 415 && tinyJ.status === 415,
    "不足 12 字节的「图片」两栈都判不符", `${tinyN.status}/${tinyJ.status}`);
  const [noFieldN, noFieldJ] = await Promise.all([
    call(NODE, "POST", "/api/uploads", (() => { const f = new FormData(); f.append("file", "纯文本字段"); return f; })(), writer),
    call(JAVA, "POST", "/api/uploads", (() => { const f = new FormData(); f.append("file", "纯文本字段"); return f; })(), writer),
  ]);
  check(noFieldN.status === 400 && noFieldJ.status === 400 && noFieldJ.json?.error === "缺少 file 字段",
    "file 是普通表单字段而不是文件 → 400", `${noFieldN.json?.error} / ${noFieldJ.json?.error}`);
  const bigPng = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024, 1)]);
  const [bigN, bigJ] = await Promise.all([
    call(NODE, "POST", "/api/uploads", formWith(bigPng, "b.png", "image/png"), writer),
    call(JAVA, "POST", "/api/uploads", formWith(bigPng, "b.png", "image/png"), writer),
  ]);
  check(bigN.status === 413 && bigJ.status === 413 && bigJ.json?.error === "图片不能超过 5MB",
    "超 5MB → 413 且是**应用层**的 JSON 文案（不能让容器先把请求拦成 Spring 的错误页）",
    `${bigN.status}/${bigJ.status} ${String(bigJ.json?.error ?? bigJ.text).slice(0, 40)}`);
  const okN = await call(NODE, "POST", "/api/uploads", formWith(PNG, "real.png", "image/png"), writer);
  const okJ = await call(JAVA, "POST", "/api/uploads", formWith(PNG, "real.png", "image/png"), writer);
  const nameOf = (r) => String(r.json?.url ?? "").replace("/uploads/", "");
  check(okN.status === 200 && okJ.status === 200 && /^\/uploads\/\d{13}-[0-9a-f]{8}\.png$/.test(String(okJ.json?.url)),
    "真 PNG 上传成功，文件名是 毫秒-8位hex.png", okJ.json?.url);
  // 这一条是这批最容易配错、又最难被"各测各的"发现的：两栈必须写进同一个磁盘目录
  const served = await fetch(`${NODE}/uploads/${nameOf(okJ)}`);
  const onDisk = fs.existsSync(path.join(UPLOAD_DIR, nameOf(okJ)));
  check(served.status === 200 && onDisk && served.headers.get("content-type")?.includes("image/png"),
    "Java 写的图，Node 直接伺服得到（两栈共用 public/uploads，否则表现为「上传成功却 404」）",
    `Java 上传 → Node GET ${served.status}`);
  const regRows = await many("SELECT filename, mime, size FROM uploads WHERE filename IN (?, ?)",
    [nameOf(okN), nameOf(okJ)]);
  check(regRows.length === 2 && regRows.every((r) => r.mime === "image/png" && Number(r.size) === PNG.length),
    "两栈都登记了 uploads 索引行（mime 存的是声明值）", JSON.stringify(regRows));

  /* ---------- 7 专栏：新建与元信息 ---------- */
  console.log("\n## 7 专栏：坏 JSON 与空对象是两种 400");
  const [badJsonN, badJsonJ] = await Promise.all([
    rawCall(NODE, "POST", "/api/series", "{不是 json", writer),
    rawCall(JAVA, "POST", "/api/series", "{不是 json", writer),
  ]);
  check(badJsonN.status === 400 && badJsonJ.status === 400
    && badJsonN.json?.error === "请求格式有误" && badJsonJ.json?.error === "请求格式有误",
    "坏 JSON → 400 请求格式有误（这条不是 .catch(()=>({}))，两栈都不能「降级成空对象」）",
    `${badJsonN.json?.error} / ${badJsonJ.json?.error}`);
  const [shortN, shortJ] = await Promise.all([
    call(NODE, "POST", "/api/series", {}, writer),
    call(JAVA, "POST", "/api/series", {}, writer),
  ]);
  check(shortN.status === 400 && shortJ.status === 400 && shortJ.json?.error === "专栏题名需 2-60 字",
    "空对象 → 走业务校验那条 400（与上一条是两个分支）", `${shortN.json?.error} / ${shortJ.json?.error}`);
  const mk = await call(JAVA, "POST", "/api/series", { title: `${TAG}·柜`, description: "闸门建的专栏" }, writer);
  const seriesId = Number(mk.json?.id);
  check(mk.status === 200 && mk.java === true && seriesId > 0
    && (await only("SELECT author_id FROM series WHERE id = ?", [seriesId]))?.author_id === writerId,
    "Java 建柜并回自增 id", mk.json);
  const mkN = await call(NODE, "POST", "/api/series", { title: `${TAG}·柜 N` }, writer);
  const seriesIdN = Number(mkN.json?.id);
  const onlyDesc = await call(NODE, "PATCH", `/api/series/${seriesId}`, { description: "只改简介" }, writer);
  const afterDesc = await only("SELECT title, description, bundle_price FROM series WHERE id = ?", [seriesId]);
  check(onlyDesc.status === 200 && afterDesc?.title === `${TAG}·柜` && afterDesc?.description === "只改简介"
    && afterDesc?.bundle_price === null,
    "PATCH 只带 description：题名与打包价一律不动（未传的列由 IF 保持原值）", JSON.stringify(afterDesc));
  // 每个用例前把打包价重置成一个"必然不同"的值：affectedRows 判的是真改动的行数，
  // 连着两次设同一个价，第二次在**两栈都会**被判成"专栏不存在或无权修改"（no-op），
  // 那是 MySQL 的口径而不是 bug，但会把这个用例变成假失败——所以要先把列挪开。
  for (const [price, want] of [[500, 500], [null, null], ["", null], [0, null], [-5, 400], [100000, 400], ["777", 777]]) {
    const one = async (base) => {
      await conn.query("UPDATE series SET bundle_price = 424242 WHERE id = ?", [seriesId]);
      const r = await call(base, "PATCH", `/api/series/${seriesId}`, { bundlePrice: price }, writer);
      const col = await only("SELECT bundle_price FROM series WHERE id = ?", [seriesId]);
      return { status: r.status, error: r.json?.error, col: col?.bundle_price === null ? null : Number(col.bundle_price) };
    };
    const n = await one(NODE);
    const j = await one(JAVA);
    check(n.status === j.status && n.col === j.col
      && (want === 400 ? n.status === 400 : n.status === 200 && n.col === want),
      `bundlePrice=${JSON.stringify(price)} → ${want === 400 ? "400" : `落库 ${want}`}`,
      `Node ${n.status}/列 ${n.col} · Java ${j.status}/列 ${j.col}`);
  }
  await sameBoth("打包价越界文案两栈一致", "PATCH", `/api/series/${seriesId}`,
    { bundlePrice: 999999 }, writer, 400);
  const [noAuthN, noAuthJ] = await Promise.all([
    call(NODE, "PATCH", `/api/series/${seriesId}`, { description: "别人来改" }, probe),
    call(JAVA, "PATCH", `/api/series/${seriesId}`, { description: "别人来改" }, probe),
  ]);
  check(noAuthN.status === 403 && noAuthJ.status === 403
    && noAuthN.json?.error === "专栏不存在或无权修改" && noAuthJ.json?.error === noAuthN.json?.error,
    "改别人的柜子 → 403 且文案不泄露「到底是不存在还是没权限」", `${noAuthN.status}/${noAuthJ.status}`);
  const [badIdN, badIdJ] = await Promise.all([
    call(NODE, "PATCH", "/api/series/abc", { description: "x" }, writer),
    call(JAVA, "PATCH", "/api/series/abc", { description: "x" }, writer),
  ]);
  check(badIdN.status === 404 && badIdJ.status === 404 && badIdJ.json?.error === "专栏不存在",
    "非数字 id → 404 而不是 500（Number.isInteger 判据）", `${badIdN.status}/${badIdJ.status}`);

  /* ---------- 8 专栏篇目：整单语义 ---------- */
  console.log("\n## 8 篇目重设：要么全换要么不动，并发不许把柜子清空");
  // 三篇自己的 + 一篇别人的，全部本次新建：断言"混进别人的稿就整单拒"需要一个
  // **确定存在且确定不归我**的 slug，库里凑不巧就没有这种稿子。
  const artA = await fixture(writerId, "柜内一");
  const artB = await fixture(writerId, "柜内二");
  const artForeign = await fixture(probeId, "别人的稿");
  const mySlugs = [artA.slug, artB.slug];
  const foreign = artForeign.slug;
  const set1 = await call(JAVA, "PATCH", `/api/series/${seriesId}`, { slugs: mySlugs.slice(0, 2) }, writer);
  const items1 = await many("SELECT article_id, position FROM series_items WHERE series_id = ? ORDER BY position", [seriesId]);
  check(set1.status === 200 && items1.length === 2 && Number(items1[0].position) === 0
    && Number(items1[1].position) === 1,
    "按数组下标定 position（顺序只有这一个来源）", JSON.stringify(items1.map((r) => r.position)));
  const polluted = await call(NODE, "PATCH", `/api/series/${seriesId}`,
    { slugs: [mySlugs[0], foreign] }, writer);
  const items2 = await many("SELECT article_id FROM series_items WHERE series_id = ?", [seriesId]);
  check(polluted.status === 400 && items2.length === 2,
    "夹带一篇别人的稿 → 整单 400 且**原柜子一篇不少**（DELETE 在校验之后、同一事务内）",
    `${polluted.json?.error} / 现存 ${items2.length} 篇`);
  const pollutedJ = await call(JAVA, "PATCH", `/api/series/${seriesId}`,
    { slugs: [mySlugs[0], foreign] }, writer);
  check(pollutedJ.status === 400 && pollutedJ.json?.error === polluted.json?.error,
    "Java 同判同文案", pollutedJ.json?.error);
  const dup = await call(JAVA, "PATCH", `/api/series/${seriesId}`, { slugs: [mySlugs[0], mySlugs[0]] }, writer);
  check(dup.status === 400, "重复篇目直接拒（否则撞 series_items 主键）", dup.json?.error);
  const cleared = await call(NODE, "PATCH", `/api/series/${seriesId}`, { slugs: [] }, writer);
  check(cleared.status === 200 && (await num("SELECT COUNT(*) FROM series_items WHERE series_id = ?", [seriesId])) === 0,
    "slugs:[] 是合法指令：清空柜子（空数组不是「没传」）");
  await call(JAVA, "PATCH", `/api/series/${seriesId}`, { slugs: mySlugs.slice(0, 2) }, writer);
  const shots = await Promise.all(Array.from({ length: 12 }, (_, k) => {
    const base = k % 2 ? JAVA : NODE;
    const slugs = k % 3 === 0 ? mySlugs.slice(0, 2) : [mySlugs[1], mySlugs[0]].slice(0, 2);
    return call(base, "PATCH", `/api/series/${seriesId}`, { slugs }, writer);
  }));
  const bad500 = shots.filter((r) => r.status >= 500).length;
  const itemsAfter = await num("SELECT COUNT(*) FROM series_items WHERE series_id = ?", [seriesId]);
  check(bad500 === 0 && itemsAfter === 2,
    "12 路跨栈并发重设：零 500、条目数守恒为 2（原实现是 3 成 9 抛、柜子被清空且不回填）",
    `500 数 ${bad500} / 条目 ${itemsAfter}`);
  const noOrder = shots.every((r) => [200, 400, 403].includes(r.status));
  check(noOrder, "并发结果只可能是成功或明确拒绝，不是一路 500", shots.map((r) => r.status).join(","));

  const delForeign = await call(JAVA, "DELETE", `/api/series/${seriesId}`, undefined, probe);
  check(delForeign.status === 403 && delForeign.json?.error === "专栏不存在或无权删除",
    "删别人的柜子 → 403", delForeign.json?.error);
  const delOk = await call(NODE, "DELETE", `/api/series/${seriesIdN}`, undefined, writer);
  check(delOk.status === 200 && (await num("SELECT COUNT(*) FROM series WHERE id = ?", [seriesIdN])) === 0,
    "删自己的柜生效，条目靠外键 CASCADE 一起走");

  /* ---------- 9 改密 ---------- */
  console.log("\n## 9 改密：两个入口共用一套策略，但契约有微小差别");
  const NEW_PW = "p5dGate2026x";
  const SEC_PW = "p5dGate2026y";
  const weakN = await call(NODE, "PATCH", "/api/me/password", { oldPassword: env.INK_WRITER_PASSWORD, newPassword: "short" }, writer);
  const weakJ = await call(JAVA, "PATCH", "/api/me/password", { oldPassword: env.INK_WRITER_PASSWORD, newPassword: "short" }, writer);
  check(weakN.status === 400 && weakJ.status === 400 && weakN.json?.error === weakJ.json?.error,
    "强度门槛两侧同 400 同文案", `${weakN.json?.error} / ${weakJ.json?.error}`);
  const sameAsOld = await call(JAVA, "PATCH", "/api/me/password",
    { oldPassword: env.INK_WRITER_PASSWORD, newPassword: env.INK_WRITER_PASSWORD }, writer);
  check(sameAsOld.status === 400 && sameAsOld.json?.error === "新密码不能与旧密码相同",
    "书房入口多一条「不能与旧密码相同」", sameAsOld.json?.error);
  const secSame = await call(JAVA, "POST", "/api/security/password",
    { oldPassword: env.INK_WRITER_PASSWORD, newPassword: env.INK_WRITER_PASSWORD }, writer);
  check(!(secSame.status === 400 && secSame.json?.error === "新密码不能与旧密码相同"),
    "安全中心入口没有「不能与旧密码相同」这一条：两入口的差别被钉住，不是一处改了另一处悄悄跟上",
    `${secSame.status} ${secSame.json?.error}`);
  const wrong1 = await call(NODE, "PATCH", "/api/me/password",
    { oldPassword: "完全不对的旧密码abc12", newPassword: NEW_PW }, writer);
  const wrong2 = await call(JAVA, "PATCH", "/api/me/password",
    { oldPassword: "完全不对的旧密码abc12", newPassword: NEW_PW }, writer);
  // 两侧都回"还可尝试 4 次"——听起来一样，其实说明计数器**没有跨栈共享**：
  // lib/rate-limit 与 Java 的 LoginGuard 都是进程内的 Map，双轨期同一个 uid+ip 各有一份，
  // 5+5 也不会锁。这条不是"通过"，是把已知的口子中门亮出来（收口方案见 README 与 P7）。
  check(wrong1.status === 401 && wrong2.status === 401
    && wrong1.json?.error === "旧密码不正确（还可尝试 4 次）"
    && wrong2.json?.error === wrong1.json?.error,
    "【已知口子】失败计数是进程内的：两栈各记各的，同一个 uid+ip 各有 5 次额度",
    `${wrong1.json?.error} / ${wrong2.json?.error}`);
  const changed = await call(JAVA, "PATCH", "/api/me/password",
    { oldPassword: env.INK_WRITER_PASSWORD, newPassword: NEW_PW }, writer);
  const hashAfter = await only("SELECT password_hash FROM users WHERE id = ?", [writerId]);
  check(changed.status === 200 && changed.json?.ok === true && changed.json?.revoked >= 1
    && hashAfter?.password_hash !== state.snap.password_hash && changed.json?.hint === undefined,
    "改密成功：哈希列真的换了、回 revoked、且书房入口不回 hint", JSON.stringify(changed.json));
  // 同一个流程从安全中心入口再过一遍：这条要的就是它独有的 hint 字段
  const viaSec = await call(NODE, "POST", "/api/security/password",
    { oldPassword: NEW_PW, newPassword: SEC_PW }, writer);
  check(viaSec.status === 200 && typeof viaSec.json?.hint === "string",
    "安全中心入口成功时多回一个 hint（两入口的分支差异必须各测一次）", JSON.stringify(viaSec.json));
  const writerNewJ = await login(JAVA, env.INK_WRITER_EMAIL, SEC_PW);
  const writerNewN = await login(NODE, env.INK_WRITER_EMAIL, SEC_PW);
  check(Boolean(writerNewJ && writerNewN), "新密码在 Java 与 Node 都能登录（scrypt 口径一致）");
  // 复原**只能靠 cleanup 直接写回 password_hash 快照**：这个克隆库的联调密码在 HIBP 泄露库里，
  // 用接口改回去会被泄露检查拒掉——那是策略该有的行为，不是 bug。
}

/**
 * 直接建夹具文章（走 SQL 而不是接口：不触发发布奖励，也不污染墨仓账）。
 * 足迹与篇目两类断言都要"确定存在、确定归谁"的稿子，库里凑不出来。
 */
async function fixture(authorId, name) {
  const slug = `p5d-${name}-${Math.floor(Math.random() * 1e6)}`;
  await conn.query(
    `INSERT INTO articles (author_id, slug, title, md_content, summary, tags, status, review_status, published_at)
     VALUES (?,?,?,?,?,?, 'published', 'approved', NOW())`,
    [authorId, slug, `${TAG}·${name}`, "闸门夹具正文，至少十个字。", "摘要", '["闸门"]']
  );
  const id = Number((await only("SELECT id FROM articles WHERE slug = ?", [slug])).id);
  fixtures.push({ id, slug });
  return { id, slug };
}

async function cleanup(c) {
  if (!c.mark || !c.snap) return; // 还没抄到快照就死了：没有可复原的东西
  // 密码按快照直接写回，不走接口：这个克隆库的联调密码在 HIBP 泄露名单里，
  // 用接口改回去会被泄露检查拒掉（那是策略该有的行为，但不是清场该有的姿势）。
  await conn.query("UPDATE users SET password_hash = ?, nickname=?, avatar_text=?, avatar_tone=?,"
    + " avatar_shape=?, bio=? WHERE id = ?",
  [c.snap.password_hash, c.snap.nickname, c.snap.avatar_text, c.snap.avatar_tone,
    c.snap.avatar_shape, c.snap.bio, c.writerId]);
  await conn.query("DELETE FROM drafts WHERE id > ?", [c.mark.draft]);
  await conn.query("DELETE FROM link_whitelist WHERE id > ? OR domain LIKE 'p5d-%'", [c.mark.link]);
  await conn.query("DELETE FROM read_history WHERE id > ?", [c.mark.history]);
  await conn.query("DELETE FROM series_items WHERE series_id > ?", [c.mark.series]);
  await conn.query("DELETE FROM series WHERE id > ?", [c.mark.series]);
  const files = await many("SELECT filename FROM uploads WHERE id > ?", [c.mark.upload]);
  for (const f of files) {
    await conn.query("DELETE FROM uploads WHERE filename = ?", [f.filename]);
    try { fs.rmSync(path.join(UPLOAD_DIR, f.filename)); } catch { /* 已被删 */ }
  }
  // 再按文件名里的毫秒戳扫一遍：上传登记是 fire-and-forget，Node 那行 INSERT 可能落在
  // 上面的 SELECT 之后，只按登记表清就会留下"库里没行、磁盘上有图"的孤儿文件
  for (const f of sweepUploads(START_MS)) {
    try { fs.rmSync(path.join(UPLOAD_DIR, f)); } catch { /* 已被删 */ }
  }
  for (const art of fixtures) {
    for (const t of ["article_boosts", "article_tips", "article_likes", "bookmarks",
      "read_history", "comments", "series_items", "article_purchases"]) {
      await conn.query(`DELETE FROM ${t} WHERE article_id = ?`, [art.id]);
    }
    await conn.query("DELETE FROM articles WHERE id = ?", [art.id]);
  }
  // 再按 slug 前缀扫一遍：中途异常退出的那一次来不及把文章记进 fixtures，
  // 只按登记表清就会永远留下"上一轮的闸门夹具文章"（残留检查第一个报的就是它）。
  const strays = await many("SELECT id FROM articles WHERE slug LIKE 'p5d-%'");
  for (const art of strays) {
    for (const t of ["article_boosts", "article_tips", "article_likes", "bookmarks",
      "read_history", "comments", "series_items", "article_purchases"]) {
      await conn.query(`DELETE FROM ${t} WHERE article_id = ?`, [art.id]);
    }
    await conn.query("DELETE FROM articles WHERE id = ?", [art.id]);
  }
  const parts = {
    drafts: await num("SELECT COUNT(*) FROM drafts WHERE id > ?", [c.mark.draft]),
    links: await num("SELECT COUNT(*) FROM link_whitelist WHERE id > ? OR domain LIKE 'p5d-%'", [c.mark.link]),
    history: await num("SELECT COUNT(*) FROM read_history WHERE id > ?", [c.mark.history]),
    series: await num("SELECT COUNT(*) FROM series WHERE id > ?", [c.mark.series]),
    items: await num("SELECT COUNT(*) FROM series_items WHERE series_id > ?", [c.mark.series]),
    uploads: await num("SELECT COUNT(*) FROM uploads WHERE id > ?", [c.mark.upload]),
    articles: await num("SELECT COUNT(*) FROM articles WHERE slug LIKE 'p5d-%'"),
    files: sweepUploads(START_MS).length,
  };
  const left = Object.values(parts).reduce((a, b) => a + b, 0);
  const stillChanged = await num("SELECT COUNT(*) FROM users WHERE id = ? AND (nickname <> ? OR password_hash <> ?)",
    [c.writerId, c.snap.nickname, c.snap.password_hash]);
  if (left !== 0) throw new Error(`清场后仍有残留：${JSON.stringify(parts)}`);
  if (stillChanged !== 0) throw new Error("写侧账号的资料或密码未复原");
}
