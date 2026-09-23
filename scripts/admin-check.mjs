#!/usr/bin/env node
// P5c 运营台闸门：门禁、原文读取、导出、内容管理、评论删除、举报处理、用户管理。
//
// 这一批的洞不在"算得对不对"，而在**权限与状态机**：
//   1) 门禁必须逐条接口都在：401/403 少一个，运营台就成了任何人都能调的写接口。
//   2) 状态机要可回退：pin 是 toggle、unpublish 必须连带清置顶、审核要写 review_note。
//   3) "改价"与"扣回点墨"这类动作账面必须与余额同源，扣不得就明说扣不得。
//   4) 导出与原文是把**全文**交出去的口子：付费墙与作者判定少判一句就是可无限拉全文的洞；
//      导出的绝对链接还必须落在浏览器看到的那个地址上（不能被 rewrite 换成后端端口）。
//   5) 跨栈互认：Node 种的评论 Java 删得掉、Node 提的举报 Java 处理得了。
//
//   node scripts/admin-check.mjs          跑完把夹具与涉事账号复原
//   node scripts/admin-check.mjs --keep   保留现场
//
// 前提：两栈已启动（Node 3200 / Java 3101），DATABASE_URL 指向**克隆库** inkstack_j。
// 经代理那两条需要切流实例在线：
//   NEXT_DIST_DIR=.next-cutover JAVA_ROUTES=…/api/articles/*/raw,…/api/articles/*/export \
//     node node_modules/next/dist/bin/next dev -p 3400
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
const PROXY = process.env.PROXY_BASE || "http://localhost:3400";
const KEEP = process.argv.includes("--keep");

const TAG = "P5c 运营台夹具";
// 正文刻意排到 9 行：读侧的付费墙是在 SQL 层用 SUBSTRING_INDEX(md,'\n',6) 截断的，
// 只有第 7 行以后才有内容，"导出的是全文"这句话才可被断言（三段式的正文永远截不出差别）。
const TAIL = "尾段：这一段在第 6 行之后，被 SQL 层截断过就一定不会出现。";
const MD = [
  "运营台闸门的正文，至少十个字。",
  "",
  "第二段。",
  "",
  "第三段。",
  "",
  "第四段。",
  "",
  TAIL,
].join("\n");

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
  const h = { ...(cookie ? { cookie } : {}) };
  if (body !== undefined) h["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(base + url, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (down) {
    return { status: 0, json: null, text: `${base} 连不上`, java: false };
  }
  const text = await res.text();
  let json = null;
  if (!raw) { try { json = JSON.parse(text); } catch { /* 文本响应 */ } }
  return {
    status: res.status, json, text,
    java: res.headers.get("x-backend") === "inkstack-java",
    cd: res.headers.get("content-disposition") || "",
    ct: res.headers.get("content-type") || "",
  };
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
const both = (url, body, cookie) => Promise.all([
  call(NODE, "POST", url, body, cookie), call(JAVA, "POST", url, body, cookie),
]);
/** 两侧同状态同文案（运营台的文案就是接口契约的一部分）。 */
async function sameError(label, url, body, cookie, want) {
  const [n, j] = await both(url, body, cookie);
  check(n.status === want && j.status === want && n.json?.error === j.json?.error,
    label, `${n.json?.error} / ${j.json?.error}`);
  return [n, j];
}
const keysOf = (o) => Object.keys(o ?? {}).join(",");
/**
 * 导出正文里嵌着绝对链接，两侧各用自己的 origin 拼接（.env 没配 NEXT_PUBLIC_SITE_URL），
 * 所以"逐字相同"必须先抹掉各自的站点地址——否则这条断言永远只在同栈内成立。
 */
const norm = (s, origin) => s.split(origin).join("<ORIGIN>");

const created = [];
let ctx = null;

try {
  ctx = await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  if (ctx && !KEEP) {
    try {
      await cleanup(ctx);
      console.log("\n已清场：夹具文章/评论/举报/流水/审计/站内信删除，涉事账号封禁与余额复原");
    } catch (e) {
      console.error("清场失败，克隆库可能残留测试数据：", e.message);
      fail++;
    }
  } else if (ctx) {
    console.log("\n--keep：现场未清理");
  }
  await conn.end().catch(() => {});
}
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

/* ==================== 用例主体 ==================== */

async function suit() {
  const writerId = await num("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]);
  const adminId = await num("SELECT id FROM users WHERE email = ?", [env.INK_TEST_EMAIL]);
  const probeId = await num("SELECT id FROM users WHERE email = ?", [env.INK_PROBE_EMAIL]);
  if (!writerId || !adminId || !probeId) throw new Error("账号缺失");
  const writer = await login(NODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  const admin = await login(NODE, env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD);
  const probe = await login(NODE, env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD);
  const adminRole = await only("SELECT role FROM users WHERE id = ?", [adminId]);
  check(adminRole?.role === "admin", `联调员是 admin（不是 developer）—— setRole 的越权分支靠它`, adminRole?.role);

  // 夹具：两篇已发布文 + 一篇付费文（未解锁）+ 一篇待审稿，全部由本次创建、结尾删除
  const artId = await fixture(writerId, `${TAG}·A`, "published", 0);
  const paidId = await fixture(writerId, `${TAG}·付费`, "published", 30);
  const pendingId = await fixture(writerId, `${TAG}·待审`, "published", 0, "pending");
  const paidSlug = (await only("SELECT slug FROM articles WHERE id = ?", [paidId])).slug;
  const mark = {
    notice: await num("SELECT IFNULL(MAX(id),0) FROM notifications"),
    ledger: await num("SELECT IFNULL(MAX(id),0) FROM point_ledger"),
    action: await num("SELECT IFNULL(MAX(id),0) FROM admin_actions"),
    comment: await num("SELECT IFNULL(MAX(id),0) FROM comments"),
    report: await num("SELECT IFNULL(MAX(id),0) FROM reports"),
  };
  const balProbe = await num("SELECT points_balance FROM users WHERE id = ?", [probeId]);
  const ctxLocal = { writerId, adminId, probeId, artId, paidId, pendingId, mark, balProbe, created: [] };

  /* ---------- 1 门禁 ---------- */
  console.log("\n## 1 门禁：四条接口都要 401/403");
  const gated = [
    ["/api/admin/articles", { slug: "x", action: "pin" }],
    ["/api/admin/comments", { commentId: 1, action: "delete" }],
    ["/api/admin/reports", { reportId: 1, handle: "keep" }],
    ["/api/admin/users", { userId: 1, action: "unban" }],
  ];
  for (const [url, body] of gated) {
    const anon = await both(url, body, undefined);
    check(anon.every((r) => r.status === 401 && r.json?.error === "请先登录"),
      `未登录打 ${url} → 401`, `${anon[0].status}/${anon[1].status}`);
    const notStaff = await both(url, body, probe);
    check(notStaff.every((r) => r.status === 403 && r.json?.error === "仅管理团队可操作"),
      `读者打 ${url} → 403`, `${notStaff[0].status}/${notStaff[1].status}`);
  }

  /* ---------- 2 参数形状 ---------- */
  console.log("\n## 2 参数形状与文案");
  await sameError("users 缺 userId → 400", "/api/admin/users", { action: "ban" }, admin, 400);
  await sameError("users 未知动作 → 400", "/api/admin/users", { userId: probeId, action: "fly" }, admin, 400);
  await sameError("articles 缺 slug → 400", "/api/admin/articles", { action: "pin" }, admin, 400);
  await sameError("articles 未知 action → 400（枚举文案）", "/api/admin/articles",
    { slug: "x", action: "nope" }, admin, 400);
  await sameError("reports handle 非法 → 400", "/api/admin/reports", { reportId: 1, handle: "?" }, admin, 400);
  await sameError("comments action 非 delete → 400", "/api/admin/comments",
    { commentId: 1, action: "hide" }, admin, 400);

  /* ---------- 3 原文读取 ---------- */
  console.log("\n## 3 /raw：全文出口之一，只认作者与运营");
  const artSlug = (await only("SELECT slug FROM articles WHERE id = ?", [artId])).slug;
  ctxLocal.created.push({ id: artId }, { id: paidId }, { id: pendingId });
  const rawAnon = await call(JAVA, "GET", `/api/articles/${artSlug}/raw`);
  check(rawAnon.status === 401 && rawAnon.json?.error === "请先登录", "未登录读原文 401");
  const rawOther = await call(NODE, "GET", `/api/articles/${artSlug}/raw`, undefined, probe);
  const rawOtherJ = await call(JAVA, "GET", `/api/articles/${artSlug}/raw`, undefined, probe);
  check(rawOther.status === 403 && rawOtherJ.status === 403
    && rawOtherJ.json?.error === "仅作者本人可读取原文", "非作者读原文 403", rawOtherJ.json);
  const rawMissing = await call(JAVA, "GET", "/api/articles/p5-no-such/raw", undefined, admin);
  check(rawMissing.status === 404 && rawMissing.json?.error === "文章不存在", "不存在的稿 404");
  const rawWriterN = await call(NODE, "GET", `/api/articles/${artSlug}/raw`, undefined, writer);
  const rawWriterJ = await call(JAVA, "GET", `/api/articles/${artSlug}/raw`, undefined, writer);
  check(rawWriterN.status === 200 && rawWriterJ.status === 200
    && JSON.stringify(rawWriterN.json) === JSON.stringify(rawWriterJ.json),
    "作者读原文：两栈响应逐字一致", `keys=${keysOf(rawWriterJ.json?.article)}`);
  check(keysOf(rawWriterJ.json?.article)
    === "slug,title,md,summary,tags,coverLabel,reviewStatus,reviewNote,status,unlockPrice,discountPrice,discountUntil",
    "raw 的 article 键序与 Node 相同", keysOf(rawWriterJ.json?.article));
  const rawAdmin = await call(JAVA, "GET", `/api/articles/${artSlug}/raw`, undefined, admin);
  check(rawAdmin.status === 200, "运营可读他人原文（审核与处置需要）", rawAdmin.status);
  const paidRaw = await call(JAVA, "GET", `/api/articles/${paidSlug}/raw`, undefined, writer);
  check(paidRaw.json?.article?.md === MD
    && paidRaw.json?.article?.unlockPrice === 30 && paidRaw.json?.article?.discountUntil === null,
    "付费字段原样带回，未设折扣时 discountUntil 为 null 而不是省略", paidRaw.json?.article);
  // 折扣截止：mysql2 把 DATETIME 按**驱动本地时区**解释（本机 +08，实测
  //   SELECT CAST('2030-01-02 03:04:05' AS DATETIME) → 2030-01-01T19:04:05.000Z），
  //   Node 再 .toISOString() 吐 UTC 串。所以口径是"两侧都必须按驱动时区解释成同一个瞬间"，
  //   而不是"库里的串就是 UTC"——把它当 UTC 读会让早鸟到点整体偏一个时区。
  await conn.query(
    "UPDATE articles SET discount_price = 12, discount_until = '2030-01-02 03:04:05' WHERE id = ?", [paidId]);
  const dN = await call(NODE, "GET", `/api/articles/${paidSlug}/raw`, undefined, writer);
  const dJ = await call(JAVA, "GET", `/api/articles/${paidSlug}/raw`, undefined, writer);
  const wantIso = new Date("2030-01-02T03:04:05").toISOString();
  check(dN.json?.article?.discountUntil === wantIso && dJ.json?.article?.discountUntil === wantIso,
    "折扣截止：两栈都按驱动本地时区解释，吐回同一个 UTC 瞬间",
    `Node ${dN.json?.article?.discountUntil} / Java ${dJ.json?.article?.discountUntil} / 期望 ${wantIso}`);
  await conn.query("UPDATE articles SET discount_price = NULL, discount_until = NULL WHERE id = ?", [paidId]);

  /* ---------- 4 导出 ---------- */
  console.log("\n## 4 /export：另一个全文出口，防线是付费墙");
  const ex404 = await call(JAVA, "GET", "/api/articles/p5-no-such/export", undefined, writer, true);
  check(ex404.status === 404 && ex404.text === "Not Found", "不存在的稿 → 纯文本 404", ex404.text.slice(0, 30));
  const exFree = await call(JAVA, "GET", `/api/articles/${artSlug}/export`, undefined, writer, true);
  check(exFree.status === 200 && exFree.ct.startsWith("text/markdown")
    && exFree.cd.includes(`filename="${artSlug}.md"`) && exFree.text.startsWith("---\n"),
    "免费文导出：markdown 附件 + frontmatter", exFree.cd.slice(0, 60));
  const paidAnon = await call(NODE, "GET", `/api/articles/${paidSlug}/export`, undefined, undefined, true);
  const paidReaderJ = await call(JAVA, "GET", `/api/articles/${paidSlug}/export`, undefined, probe, true);
  check(paidAnon.status === 402 && paidAnon.text === "Payment Required"
    && paidReaderJ.status === 402,
    "未解锁的付费文：游客与登录读者一律 402，不吐一个字", `${paidAnon.status}/${paidReaderJ.status}`);
  const paidOwner = await call(JAVA, "GET", `/api/articles/${paidSlug}/export`, undefined, writer, true);
  check(paidOwner.status === 200 && paidOwner.text.includes(TAIL),
    "作者本人可导出自己的付费文，且拿到的是全文（越过第 6 行的截断）", paidOwner.status);
  await conn.query(
    `INSERT INTO article_purchases (article_id, user_id, price, author_gain) VALUES (?,?,?,?)`,
    [paidId, probeId, 30, 21]);
  const paidBuyer = await call(NODE, "GET", `/api/articles/${paidSlug}/export`, undefined, probe, true);
  const paidBuyerJ = await call(JAVA, "GET", `/api/articles/${paidSlug}/export`, undefined, probe, true);
  check(paidBuyer.status === 200 && paidBuyerJ.status === 200
    && norm(paidBuyer.text, NODE) === norm(paidBuyerJ.text, JAVA) && paidBuyer.text.includes(TAIL),
    "已购读者能导出，两侧正文一致（抹掉各自的站点地址后）且为全文", `${paidBuyer.text.length}B`);
  const words = Number((paidBuyer.text.match(/^words: (\d+)$/m) ?? [])[1]);
  // 与 Node 同式：去掉所有空白后计数，含全角空格（Java 的 \s 不认 U+3000，字数会偏大）
  check(words > 0 && words === MD.replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, "").length,
    "frontmatter 的字数按\"去掉所有空白\"算", `words=${words}`);
  try {
    const viaProxy = await call(PROXY, "GET", `/api/articles/${artSlug}/export`, undefined, writer, true);
    const direct = await call(NODE, "GET", `/api/articles/${artSlug}/export`, undefined, writer, true);
    check(viaProxy.java === true && viaProxy.status === 200
      && !/localhost:3101/.test(viaProxy.text)
      && norm(viaProxy.text, PROXY) === norm(direct.text, NODE),
      "经代理导出：链接落在浏览器看到的地址上，绝不泄漏后端端口，正文与 Node 归一后逐字一致",
      (viaProxy.text.match(/^url: .*/m) ?? [""])[0]);
  } catch (down) {
    check(false, "经代理导出可比对（切流实例未在线？）", String(down?.message ?? down));
  }

  /* ---------- 5 内容管理 ---------- */
  console.log("\n## 5 内容管理：toggle、下架连带清置顶、审核写原因");
  const pin1 = await call(JAVA, "POST", "/api/admin/articles", { slug: artSlug, action: "pin" }, admin);
  check(pin1.status === 200 && pin1.json?.ok === true
    && (await num("SELECT pinned FROM articles WHERE id = ?", [artId])) === 1,
    "Java 置顶生效", JSON.stringify(pin1.json));
  await call(NODE, "POST", "/api/admin/articles", { slug: artSlug, action: "pin" }, admin);
  check((await num("SELECT pinned FROM articles WHERE id = ?", [artId])) === 0,
    "Node 再 pin 一次即取消（跨栈同一套 1-pinned 语义）");
  const feat = await call(NODE, "POST", "/api/admin/articles", { slug: artSlug, action: "feature" }, admin);
  await call(JAVA, "POST", "/api/admin/articles", { slug: artSlug, action: "unfeature" }, admin);
  check(feat.status === 200 && (await num("SELECT featured FROM articles WHERE id = ?", [artId])) === 0,
    "feature / unfeature 成对生效");
  await call(JAVA, "POST", "/api/admin/articles", { slug: artSlug, action: "pin" }, admin);
  const off = await call(NODE, "POST", "/api/admin/articles", { slug: artSlug, action: "unpublish" }, admin);
  const offRow = await only("SELECT status, pinned, featured FROM articles WHERE id = ?", [artId]);
  check(off.status === 200 && offRow?.status === "removed"
    && Number(offRow?.pinned) === 0 && Number(offRow?.featured) === 0,
    "下架必须连带取消置顶/精选（否则留下\"已下架还占首页\"的僵尸态）", JSON.stringify(offRow));
  await call(JAVA, "POST", "/api/admin/articles", { slug: artSlug, action: "publish" }, admin);
  await sameError("处置不存在的稿 → 400 文章不存在", "/api/admin/articles",
    { slug: "p5-no-such", action: "pin" }, admin, 400);
  const pendSlug = (await only("SELECT slug FROM articles WHERE id = ?", [pendingId])).slug;
  await sameError("驳回不带原因 → 400", "/api/admin/articles",
    { slug: pendSlug, action: "reject" }, admin, 400);
  const reject = await call(NODE, "POST", "/api/admin/articles",
    { slug: pendSlug, action: "reject", note: "   事实性错误较多   " }, admin);
  const rejected = await only(
    "SELECT review_status AS r, review_note AS n FROM articles WHERE id = ?", [pendingId]);
  check(reject.status === 200 && rejected?.r === "rejected" && rejected?.n === "事实性错误较多",
    "驳回：原因被 trim 后落 review_note", JSON.stringify(rejected));
  const rejectNotice = await only(
    "SELECT title, body, link FROM notifications WHERE user_id = ? AND type='review' AND id > ? ORDER BY id DESC LIMIT 1",
    [writerId, mark.notice]);
  check(rejectNotice?.title === "文章未通过审核"
    && rejectNotice?.body === "原因：事实性错误较多。可在书房修改后重新提交。" && rejectNotice?.link === "/study",
    "驳回通知作者的文案与链接精确", JSON.stringify(rejectNotice));
  await call(JAVA, "POST", "/api/admin/articles", { slug: pendSlug, action: "reject", note: "" }, admin);
  await sameError("驳回带空串原因同样被拒", "/api/admin/articles",
    { slug: pendSlug, action: "reject", note: "  " }, admin, 400);
  const approve = await call(JAVA, "POST", "/api/admin/articles", { slug: pendSlug, action: "approve" }, admin);
  const approved = await only("SELECT review_status AS r, review_note AS n FROM articles WHERE id = ?", [pendingId]);
  check(approve.status === 200 && approved?.r === "approved" && approved?.n === null,
    "通过：review_status=approved 且把旧的驳回说明清成 NULL", JSON.stringify(approved));
  const price = await call(NODE, "POST", "/api/admin/articles",
    { slug: artSlug, action: "price", unlockPrice: 25, discountPrice: 18 }, admin);
  const priced = await only(
    "SELECT unlock_price AS up, discount_price AS dp, discount_until IS NOT NULL AS hasUntil FROM articles WHERE id = ?",
    [artId]);
  check(price.status === 200 && Number(priced?.up) === 25 && Number(priced?.dp) === 18 && Number(priced?.hasUntil) === 1,
    "运营改价：设折扣时自动带 7 天截止", JSON.stringify(priced));
  await sameError("折扣高于原价 → 400", "/api/admin/articles",
    { slug: artSlug, action: "price", unlockPrice: 10, discountPrice: 20 }, admin, 400);
  const audited = await many(
    "SELECT action FROM admin_actions WHERE admin_id = ? AND id > ? ORDER BY id", [adminId, mark.action]);
  check(audited.length >= 8 && audited.every((a) => /^(article|review|user|comment|report):/.test(a.action)),
    "每个成功动作都落了审计日志", `${audited.length} 条：${[...new Set(audited.map(a => a.action.split(":")[0]))].join(",")}`);

  /* ---------- 6 评论管理 ---------- */
  console.log("\n## 6 评论删除：连带一级回复并扣回计数");
  await conn.query("INSERT INTO comments (article_id, user_id, content) VALUES (?,?,?)", [artId, probeId, "闸门主楼"]);
  const rootId = await num("SELECT MAX(id) FROM comments");
  await conn.query("INSERT INTO comments (article_id, user_id, parent_id, content) VALUES (?,?,?,?), (?,?,?,?)",
    [artId, probeId, rootId, "一级回复一", artId, writerId, rootId, "一级回复二"]);
  await conn.query("UPDATE articles SET comment_count = 3 WHERE id = ?", [artId]);
  const del = await call(JAVA, "POST", "/api/admin/comments", { commentId: rootId, action: "delete" }, admin);
  check(del.status === 200 && del.json?.removed === 3, "删主楼连带两条回复，removed 报真实行数", del.json);
  const afterDel = await only(
    "SELECT (SELECT COUNT(*) FROM comments WHERE article_id = ?) AS lefts, (SELECT comment_count FROM articles WHERE id = ?) AS cnt",
    [artId, artId]);
  check(Number(afterDel?.lefts) === 0 && Number(afterDel?.cnt) === 0,
    "评论清零且 comment_count 被扣回（GREATEST 不会减成负数）", JSON.stringify(afterDel));
  const delAgain = await call(NODE, "POST", "/api/admin/comments", { commentId: rootId, action: "delete" }, admin);
  const delMissing = await call(JAVA, "POST", "/api/admin/comments", { commentId: 99999999, action: "delete" }, admin);
  check(delAgain.status === 400 && delMissing.status === 400 && delMissing.json?.error === "评论不存在",
    "重复删 / 删不存在的 → 400 评论不存在", `${delAgain.json?.error} / ${delMissing.json?.error}`);

  /* ---------- 7 举报处理 ---------- */
  console.log("\n## 7 举报处理：三种处置都要把行推到终态");
  await conn.query("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?,?,?,?)",
    [probeId, "article", artId, "闸门举报·待删"]);
  const repArticle = await num("SELECT MAX(id) FROM reports");
  const handleDel = await call(JAVA, "POST", "/api/admin/reports", { reportId: repArticle, handle: "delete_content" }, admin);
  const handled = await only(
    "SELECT status, handle_note, handled_at IS NOT NULL AS at FROM reports WHERE id = ?", [repArticle]);
  const artAfter = await only("SELECT status, pinned FROM articles WHERE id = ?", [artId]);
  check(handleDel.status === 200 && handled?.status === "resolved"
    && handled?.handle_note === "已删除被举报内容" && Number(handled?.at) === 1,
    "delete_content 不带 note 时用该处置的默认说明", JSON.stringify(handled));
  check(artAfter?.status === "removed" && Number(artAfter?.pinned) === 0,
    "删文章是置 removed（软删，数据留着）", JSON.stringify(artAfter));
  await conn.query("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?,?,?,?)",
    [probeId, "article", paidId, "闸门举报·保留"]);
  const repKeep = await num("SELECT MAX(id) FROM reports");
  await call(NODE, "POST", "/api/admin/reports", { reportId: repKeep, handle: "keep" }, admin);
  const keepRow = await only("SELECT status, handle_note FROM reports WHERE id = ?", [repKeep]);
  check(keepRow?.status === "resolved" && keepRow?.handle_note === "核查后保留内容",
    "keep 只结案不动内容", JSON.stringify(keepRow));
  await call(JAVA, "POST", "/api/admin/reports", { reportId: repKeep, handle: "dismiss", note: "重复提交" }, admin);
  const again = await only("SELECT status, handle_note FROM reports WHERE id = ?", [repKeep]);
  check(again?.status === "dismissed" && again?.handle_note === "重复提交",
    "同一举报可再处理（Node 不拦二次处理，结案说明被覆盖）—— 行为照搬并记在此处", JSON.stringify(again));
  await conn.query("INSERT INTO comments (article_id, user_id, content) VALUES (?,?,?)", [paidId, probeId, "待举报评论"]);
  const badComment = await num("SELECT MAX(id) FROM comments");
  await conn.query("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?,?,?,?)",
    [writerId, "comment", badComment, "闸门评论举报"]);
  const repComment = await num("SELECT MAX(id) FROM reports");
  const handleComment = await call(NODE, "POST", "/api/admin/reports", { reportId: repComment, handle: "delete_content" }, admin);
  check(handleComment.status === 200
    && (await num("SELECT COUNT(*) FROM comments WHERE id = ?", [badComment])) === 0,
    "举报对象是评论时走真删那一条", handleComment.json);
  await sameError("处理不存在的举报 → 400", "/api/admin/reports",
    { reportId: 99999999, handle: "keep" }, admin, 400);

  /* ---------- 8 用户管理 ---------- */
  console.log("\n## 8 用户管理：封禁不许碰同行，扣墨要与余额同源");
  const ban = await call(JAVA, "POST", "/api/admin/users", { userId: probeId, action: "ban" }, admin);
  check(ban.status === 200 && (await num("SELECT banned FROM users WHERE id = ?", [probeId])) === 1,
    "Java 封禁读者生效", ban.json);
  const banNotice = await only(
    "SELECT title, body, link FROM notifications WHERE user_id = ? AND type='system' AND id > ? ORDER BY id DESC LIMIT 1",
    [probeId, mark.notice]);
  check(banNotice?.title === "你的账号已被封禁"
    && banNotice?.body === "如有疑问请联系平台邮箱申诉" && banNotice?.link === null,
    "封禁通知的文案与链接（/points 只在墨仓变动时带）", JSON.stringify(banNotice));
  const banPeer = await call(NODE, "POST", "/api/admin/users", { userId: adminId, action: "ban" }, admin);
  const banPeerJ = await call(JAVA, "POST", "/api/admin/users", { userId: adminId, action: "ban" }, admin);
  check(banPeer.status === 400 && banPeerJ.status === 400 && banPeer.json?.error === banPeerJ.json?.error
    && banPeer.json?.error === "用户不存在或为管理团队",
    "管理团队不可被封禁（admin 自己也不行，两栈同文案）", `${banPeer.json?.error} / ${banPeerJ.json?.error}`);
  await call(NODE, "POST", "/api/admin/users", { userId: probeId, action: "unban" }, admin);
  check((await num("SELECT banned FROM users WHERE id = ?", [probeId])) === 0, "Node 解封生效，封禁即时可回退");
  const grant = await call(JAVA, "POST", "/api/admin/users", { userId: probeId, action: "grant", amount: 60 }, admin);
  const grantLed = await only(
    "SELECT delta, reason FROM point_ledger WHERE user_id = ? AND id > ? AND reason LIKE '运营发放%' ORDER BY id DESC LIMIT 1",
    [probeId, mark.ledger]);
  check(grant.status === 200
    && (await num("SELECT points_balance FROM users WHERE id = ?", [probeId])) === balProbe + 60
    && Number(grantLed?.delta) === 60 && grantLed?.reason === "运营发放 60 点墨",
    "发放 60：余额与流水同时动", JSON.stringify(grantLed));
  const revokeBig = await call(NODE, "POST", "/api/admin/users", { userId: probeId, action: "revoke", amount: 10_000 }, admin);
  const bigLed = await only(
    "SELECT delta, reason FROM point_ledger WHERE user_id = ? AND id > ? AND reason LIKE '运营扣回%' ORDER BY id DESC LIMIT 1",
    [probeId, mark.ledger]);
  const nowBal = await num("SELECT points_balance FROM users WHERE id = ?", [probeId]);
  check(revokeBig.status === 200 && nowBal === 0
    && Number(bigLed?.delta) === -(balProbe + 60) && String(bigLed?.reason).includes("余额不足按实际扣减"),
    "扣回超过余额：按真实扣减额记流水，绝不出现\"账记 -10000、余额只掉 60\"", JSON.stringify(bigLed));
  await sameError("余额已为 0 再扣 → 400 说清楚", "/api/admin/users",
    { userId: probeId, action: "revoke", amount: 5 }, admin, 400);
  await sameError("数量为 0 → 400", "/api/admin/users", { userId: probeId, action: "grant", amount: 0 }, admin, 400);
  const grantAnon = await call(JAVA, "POST", "/api/admin/users", { userId: probeId, action: "grant", amount: 200 }, admin);
  const rollback = await call(NODE, "POST", "/api/admin/users", { userId: probeId, action: "revoke", amount: 200 }, admin);
  const balNow = await num("SELECT points_balance FROM users WHERE id = ?", [probeId]);
  const ledNow = await num(
    "SELECT IFNULL(SUM(delta),0) FROM point_ledger WHERE user_id = ? AND id > ? AND reason LIKE '运营%'",
    [probeId, mark.ledger]);
  check(grantAnon.status === 200 && rollback.status === 200 && balNow === 0 && ledNow === 0,
    "两栈互发一加一减后余额归零且净额为 0（跨栈锁同一行，无双花）", `余额 ${balNow} / 净流水 ${ledNow}`);
  const setRole = await call(JAVA, "POST", "/api/admin/users", { userId: probeId, action: "setRole", role: "author" }, admin);
  check(setRole.status === 403 && setRole.json?.error === "仅开发者可变更用户角色",
    "admin 也改不了角色（角色管理是 developer 专属；前端隐藏下拉不是防线）", setRole.json);
  const setRoleN = await call(NODE, "POST", "/api/admin/users", { userId: probeId, action: "setRole", role: "author" }, admin);
  check(setRoleN.status === 403, "Node 侧同判", setRoleN.json?.error);

  /* ---------- 9 账实 ---------- */
  console.log("\n## 9 账实核对");
  // 探针的运营加减被刻意配平（+60 −60 −(bal+60) …），所以净额应为 0 且余额回到水位；
  // 这同时证明两栈在同一个 users 行上串行，没有互相看不见的问题。
  const probeLed = await num(
    "SELECT IFNULL(SUM(delta),0) FROM point_ledger WHERE user_id = ? AND id > ? AND reason LIKE '运营%'",
    [probeId, mark.ledger]);
  const probeBal = await num("SELECT points_balance FROM users WHERE id = ?", [probeId]);
  check(probeLed === 0 && probeBal === balProbe,
    "探针：运营加减净额为 0 且余额回到水位（Δ余额 = ΔΣ流水 的最强形式）",
    `净流水 ${probeLed} / 余额 ${probeBal} vs 水位 ${balProbe}`);
  const actions = await num("SELECT COUNT(*) FROM admin_actions WHERE id > ?", [mark.action]);
  check(actions >= 16, `审计日志累计 ${actions} 条（每次成功动作一条）`);
  return ctxLocal;
}

/** 直接建夹具文章（走 SQL 而不是接口：不触发发布奖励，也不污染墨仓账）。 */
async function fixture(authorId, title, status, price, reviewStatus = "approved") {
  const slug = `p5c-${title.replace(/\W+/g, "-")}-${Math.floor(Math.random() * 1e6)}`;
  await conn.query(
    `INSERT INTO articles (author_id, slug, title, md_content, summary, tags, status, review_status, unlock_price)
     VALUES (?,?,?,?,?,?,?, ?, ?)`,
    [authorId, slug, title, MD, "摘要", '["闸门"]', status, reviewStatus, price]
  );
  return Number((await only("SELECT id FROM articles WHERE slug = ?", [slug])).id);
}

async function cleanup(c) {
  const ids = [...new Set([c.artId, c.paidId, c.pendingId, ...c.created.map((x) => Number(x.id))].filter(Boolean))];
  const ph = ids.map(() => "?").join(",");
  await conn.query("DELETE FROM comments WHERE id > ?", [c.mark.comment]);
  await conn.query(`DELETE FROM article_purchases WHERE article_id IN (${ph})`, ids);
  for (const t of ["article_boosts", "article_tips", "article_likes", "bookmarks",
    "read_history", "series_items", "comments"]) {
    await conn.query(`DELETE FROM ${t} WHERE article_id IN (${ph})`, ids);
  }
  await conn.query(`DELETE FROM articles WHERE id IN (${ph})`, ids);
  await conn.query("DELETE FROM reports WHERE id > ?", [c.mark.report]);
  await conn.query("DELETE FROM notifications WHERE id > ?", [c.mark.notice]);
  await conn.query("DELETE FROM admin_actions WHERE id > ?", [c.mark.action]);
  await conn.query("DELETE FROM point_ledger WHERE id > ? AND reason LIKE '运营%'", [c.mark.ledger]);
  await conn.query("UPDATE users SET points_balance = ?, banned = 0 WHERE id = ?", [c.balProbe, c.probeId]);
  const left = await num(`SELECT (SELECT COUNT(*) FROM articles WHERE title LIKE 'P5c 运营台夹具%')
    + (SELECT COUNT(*) FROM reports WHERE id > ?)
    + (SELECT COUNT(*) FROM admin_actions WHERE id > ?)
    + (SELECT COUNT(*) FROM point_ledger WHERE id > ? AND reason LIKE '运营%')
    + (SELECT COUNT(*) FROM articles WHERE slug LIKE 'p5c-%')`,
  [c.mark.report, c.mark.action, c.mark.ledger]);
  const bal = await num("SELECT points_balance FROM users WHERE id = ?", [c.probeId]);
  if (left !== 0) throw new Error(`清场后仍有残留 ${left} 项`);
  if (bal !== c.balProbe) throw new Error(`探针余额未复原：${bal} ≠ ${c.balProbe}`);
}
