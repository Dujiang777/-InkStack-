#!/usr/bin/env node
// P5b 创作台闸门：发布 / 存草稿 / 草稿转正 / 更新重审 / 撤回 / 硬删。
//
// 这条链路上有三件读侧对拍表达不了的事：
//   1) 中文标题的 slug 是**可枚举且会撞**的（一律回退成 bo-日期-1），并发发布同名标题必须
//      换号重试而不是把 7 个请求打成 500「发布失败」——用户以为没发出去，其实库里已经有了。
//   2) 审核权是"看起来像参数、其实是权限"：普通用户一律 pending、管理员一律 approved，
//      且只能由服务端从签名 Cookie 里的 role 判定。
//   3) 草稿是**硬删**：八张子表按 article_id 清完才能删主行，且必须在同一个事务里——
//      分条自动提交会留下"稿子还在、点赞却被清空"的部分删除。
//
//   node scripts/studio-check.mjs          跑完把夹具与涉事流水全部复原
//   node scripts/studio-check.mjs --keep   保留现场
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

const MD = "这是一段用于闸门的正文，至少十个字。第二行。";
const TAG = "闸门稿";

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
const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function call(base, method, urlPath, body, cookie) {
  const headers = { ...(cookie ? { cookie } : {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(base + urlPath, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (down) {
    return { status: 0, json: null, text: `${base} 连不上：${down.cause?.code ?? down.message}`, java: false };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 由调用方判定 */ }
  return { status: res.status, json, text, java: res.headers.get("x-backend") === "inkstack-java" };
}
async function login(base, email, password) {
  const r = await call(base, "POST", "/api/auth/login", { email, password });
  if (r.status !== 200) throw new Error(`${base} 登录失败 ${r.status}`);
  const raw = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (raw.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error(`${base} 未下发 ink_session`);
  return cookie;
}
const hist = (rs) => {
  const h = {};
  for (const x of rs) h[x.status] = (h[x.status] ?? 0) + 1;
  return Object.entries(h).map(([k, v]) => `${k}×${v}`).join(" ");
};
const keysOf = (o) => Object.keys(o ?? {}).join(",");

const conn = await mysql.createConnection(env.DATABASE_URL);
const only = async (sql, params = []) => (await conn.query(sql, params))[0][0] ?? null;
const many = async (sql, params = []) => (await conn.query(sql, params))[0];
const num = async (sql, params = []) => {
  const row = await only(sql, params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? 0 : Number(v);
};

/** 本次通过接口建出来的文章，按 id 清场。 */
const created = [];
let ctx = null;

/**
 * 发一篇并把它的主键/slug 回查出来。
 *
 * 注意 Node 的发布响应**只有草稿分支才带 slug**（正式发布回 ok/reviewPending/reward/...），
 * 所以 slug 必须从库里取——顺带这也是一种断言：接口说成功了，库里就得真有这一行。
 */
async function publish(base, cookie, extra) {
  const title = extra.title ?? `${TAG}·${Math.random().toString(36).slice(2, 8)}`;
  const res = await call(base, "POST", "/api/articles", { title, md: MD, ...extra }, cookie);
  const row = res.status === 200
    ? await only("SELECT id, slug FROM articles WHERE title = ? ORDER BY id DESC LIMIT 1", [title])
    : null;
  if (row?.slug) created.push({ slug: row.slug, id: Number(row.id) });
  return { ...res, slug: row?.slug ?? null, id: row?.id ?? null, title };
}

try {
  ctx = await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  if (ctx && !KEEP) {
    try {
      await cleanup(ctx);
      console.log("\n已清场：夹具文章与子行、奖励流水与计数、站内信全部删除，余额复原");
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
  const day = localDay(new Date());
  const writerId = await num("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]);
  const adminId = await num("SELECT id FROM users WHERE email = ?", [env.INK_TEST_EMAIL]);
  const probeId = await num("SELECT id FROM users WHERE email = ?", [env.INK_PROBE_EMAIL]);
  if (!writerId || !adminId || !probeId) throw new Error(`账号缺失 w=${writerId} a=${adminId} p=${probeId}`);
  const writerRole = await only("SELECT role FROM users WHERE id = ?", [writerId]);
  const adminRole = await only("SELECT role FROM users WHERE id = ?", [adminId]);
  const writer = await login(NODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  const admin = await login(NODE, env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD);
  const probe = await login(NODE, env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD);
  check(writerRole?.role !== "admin" && writerRole?.role !== "developer" && adminRole?.role === "admin",
    "前提：发文稿的账号不是运营、另一个是 admin —— 审核流的两条分支靠这两个身份跑",
    `${writerRole?.role} / ${adminRole?.role}`);
  const balWriter = await num("SELECT points_balance FROM users WHERE id = ?", [writerId]);
  const balAdmin = await num("SELECT points_balance FROM users WHERE id = ?", [adminId]);
  const mark = {
    ledger: await num("SELECT IFNULL(MAX(id),0) FROM point_ledger"),
    notice: await num("SELECT IFNULL(MAX(id),0) FROM notifications"),
  };

  /* ---------- 1 发布 ---------- */
  console.log("\n## 1 发布与审核归属");
  const p1 = await publish(NODE, writer, {});
  check(p1.status === 200 && p1.json?.ok === true && p1.json?.reviewPending === true,
    "普通作者发文 → reviewPending:true", p1.json);
  check(keysOf(p1.json) === "ok,reviewPending,reward,capped,balance",
    "首发响应键集与键序（balance 只在真发墨时出现）", keysOf(p1.json));
  check(p1.json?.reward === 20 && p1.json?.capped === false,
    "发布奖励 +20 到账", `${p1.json?.reward} / capped=${p1.json?.capped}`);
  const row1 = await only(
    "SELECT id, status, review_status AS reviewStatus, published_at IS NOT NULL AS pub FROM articles WHERE slug = ?",
    [p1.slug]);
  check(row1?.status === "published" && row1?.reviewStatus === "pending" && Number(row1?.pub) === 1,
    "落库：status=published 而 review_status=pending，published_at 已写", JSON.stringify(row1));
  const seenByJava = await call(JAVA, "GET", `/api/articles/${p1.slug}`, undefined, writer);
  check(seenByJava.status === 200, "Java 侧认得 Node 刚发布的这篇（跨栈同库）", seenByJava.status);
  const p2 = await publish(JAVA, writer, {});
  check(p2.status === 200 && p2.json?.reward === 0 && p2.json?.capped === true,
    "同一天第二篇不再发奖（日上限 1）", p2.json);
  check(!("balance" in (p2.json ?? {})),
    "没发墨时响应里根本没有 balance 键（Node 是 undefined，JSON 不产出该键）", keysOf(p2.json));
  const pAdmin = await publish(NODE, admin, {});
  const adminRow = await only("SELECT review_status AS r FROM articles WHERE slug = ?", [pAdmin.slug]);
  check(pAdmin.json?.reviewPending === false && adminRow?.r === "approved",
    "运营发文直接 approved（审核权来自 Cookie 里的 role，不是请求体）", adminRow?.r);
  const forged = await publish(JAVA, writer, { title: `${TAG}·伪造审核`, reviewStatus: "approved", role: "admin" });
  const forgedRow = await only("SELECT review_status AS r FROM articles WHERE slug = ?", [forged.slug]);
  check(forged.status === 200 && forgedRow?.r === "pending",
    "请求体里塞 reviewStatus/role 一律无效", forgedRow?.r);

  /* ---------- 2 入参校验 ---------- */
  console.log("\n## 2 入参校验（两侧文案必须逐字相同）");
  const cases = [
    [{ title: "   ", md: MD }, "标题不能为空"],
    [{ title: TAG, md: "不足十字" }, "正文太短（至少 10 字）"],
    [{ title: TAG, md: "甲".repeat(100_001) }, "正文过长（上限 10 万字）"],
  ];
  for (const [extra, want] of cases) {
    const n = await call(NODE, "POST", "/api/articles", { md: MD, ...extra }, writer);
    const j = await call(JAVA, "POST", "/api/articles", { md: MD, ...extra }, writer);
    check(n.status === 400 && j.status === 400 && n.json?.error === want && j.json?.error === want,
      `「${want}」两栈同判同文案`, `${n.json?.error} / ${j.json?.error}`);
  }
  const anon = await call(JAVA, "POST", "/api/articles", { title: TAG, md: MD });
  check(anon.status === 401 && anon.json?.error === "登录后才能发布文章", "未登录发布 401");
  const price = await publish(JAVA, writer, { title: `${TAG}·定价`, unlockPrice: 44.7, discountPrice: "30", discountUntil: futureIso(3) });
  const priced = await only(
    `SELECT unlock_price AS up, discount_price AS dp,
            DATE_FORMAT(discount_until,'%Y-%m-%d %H:%i:%s') AS du
       FROM articles WHERE slug = ?`, [price.slug]);
  check(Number(priced?.up) === 44 && Number(priced?.dp) === 30,
    "定价取整后入库（Math.floor 同式）", JSON.stringify(priced));
  const pricedNode = await publish(NODE, writer, { title: `${TAG}·定价`, unlockPrice: 44, discountPrice: 30, discountUntil: futureIso(3) });
  const priced2 = await only(
    `SELECT DATE_FORMAT(discount_until,'%Y-%m-%d %H:%i:%s') AS du FROM articles WHERE slug = ?`,
    [pricedNode.slug]);
  check(priced?.du === priced2?.du,
    "同一个 datetime-local 串两栈解析成**同一个 UTC 瞬间**（JS 按本地时区解释无时区的日期时间）",
    `${priced?.du} vs ${priced2?.du}`);
  for (const [label, until, wantNull] of [
    ["过期时间", futureIso(-1), true], ["超 30 天", futureIso(40), true],
    ["非日期", "not-a-date", true], ["折扣不小于原价", futureIso(3), true],
  ]) {
    const r = await publish(NODE, writer, {
      title: `${TAG}·${label}`, unlockPrice: label.includes("原价") ? 20 : 44,
      discountPrice: label.includes("原价") ? 20 : 30, discountUntil: until,
    });
    const got = await only("SELECT discount_price AS dp FROM articles WHERE slug = ?", [r.slug]);
    check((got?.dp === null) === wantNull, `无效早鸟（${label}）整对退回不设折扣`, JSON.stringify(got));
  }

  /* ---------- 3 slug 撞键并发 ---------- */
  console.log("\n## 3 slug：中文标题必撞，并发发布不许出 500");
  // 英文 slug 的断言要"从空位开始"才确定：上一轮若没清干净，-2 就会变成 -4，
  // 那是闸门的自污染而不是代码的回归，所以先把这个前缀整体清掉。
  await purgeSlugPrefix("gate-studio-slug-case");
  const sameTitle = `${TAG}·同名并发`;
  const same = { title: sameTitle, md: MD };
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    call(i % 2 ? JAVA : NODE, "POST", "/api/articles", same, writer)));
  check(burst.every((r) => r.status === 200 && r.json?.ok === true),
    "8 路并发同名发布全部成功（旧实现是 7×500：用户以为没发出去，重试即重复稿）", hist(burst));
  // 正式发布不回 slug，所以"8 行都在、slug 互不相同"只能从库里判
  const sameRows = await many("SELECT id, slug FROM articles WHERE title = ?", [sameTitle]);
  for (const r of sameRows) created.push({ slug: r.slug, id: Number(r.id) });
  check(sameRows.length === 8, "库里确实落了 8 行（没有丢稿也没有多写）", String(sameRows.length));
  check(new Set(sameRows.map((r) => r.slug)).size === 8,
    "8 个 slug 互不相同", sameRows.map((r) => r.slug).slice(0, 3).join(" "));
  const ascii = await publish(JAVA, writer, { title: "Gate Studio Slug Case", md: MD });
  check(ascii.slug === "gate-studio-slug-case",
    "英文标题走可读 slug", ascii.slug);
  const ascii2 = await publish(NODE, writer, { title: "Gate Studio Slug Case!", md: MD });
  check(ascii2.slug === "gate-studio-slug-case-2",
    "归一化后同名的第二篇追加 -2", ascii2.slug);

  /* ---------- 4 草稿与转正 ---------- */
  console.log("\n## 4 草稿：存、改、一键发布");
  const d1 = await publish(NODE, writer, { title: `${TAG}·草稿`, md: MD, draft: true });
  check(keysOf(d1.json) === "ok,draft,slug", "草稿响应只有三键（不进审核流、不发奖励）", keysOf(d1.json));
  const d1row = await only("SELECT id, status, review_status AS r, published_at IS NOT NULL AS pub FROM articles WHERE slug = ?", [d1.slug]);
  check(d1row?.status === "draft" && d1row?.r === "approved" && Number(d1row?.pub) === 0,
    "草稿 status=draft 且 review_status=approved、published_at 为空", JSON.stringify(d1row));
  const ledAfterDraft = await num(
    "SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND reason = '发布奖励' AND id > ?", [writerId, mark.ledger]);
  check(ledAfterDraft === 1, "草稿不发发布奖励（此时仍只有两笔）", String(ledAfterDraft));
  const saved = await call(JAVA, "PUT", `/api/articles/${d1.slug}`,
    { title: `${TAG}·草稿改过`, md: `${MD} 第二版。`, draft: true }, writer);
  check(saved.status === 200 && saved.json?.draft === true, "Java 保存草稿成功", saved.json);
  const savedRow = await only("SELECT title, md_content AS md FROM articles WHERE slug = ?", [d1.slug]);
  check(savedRow?.title === `${TAG}·草稿改过` && String(savedRow?.md).includes("第二版"),
    "草稿正文确实被覆盖", savedRow?.title);
  const publishIt = await call(NODE, "PUT", `/api/articles/${d1.slug}`, { publish: true }, writer);
  check(publishIt.status === 200 && publishIt.json?.reviewStatus === "pending"
    && publishIt.json?.publishedFromDraft === true,
    "Node 一键发布草稿（跨栈认得 Java 刚改的那行）", publishIt.json);
  const afterPub = await only(
    "SELECT status, md_content AS md, published_at IS NOT NULL AS pub FROM articles WHERE slug = ?", [d1.slug]);
  check(afterPub?.status === "published" && Number(afterPub?.pub) === 1
    && String(afterPub?.md).includes("第二版"),
    "一键发布只动状态三列、正文保持草稿原样", JSON.stringify({ s: afterPub?.status, p: Number(afterPub?.pub) }));
  const backToDraft = await call(JAVA, "PUT", `/api/articles/${d1.slug}`,
    { title: `${TAG}·想退回草稿`, md: MD, draft: true }, writer);
  check(backToDraft.status === 400
    && backToDraft.json?.error === "已发布/审核中的文章不支持存草稿，请走重新提审",
    "已发布内容不许退回草稿绕过审核", backToDraft.json?.error);
  const d2 = await publish(JAVA, writer, { title: `${TAG}·草稿2`, md: MD, draft: true });
  const reEdit = await call(NODE, "PUT", `/api/articles/${d2.slug}`,
    { title: `${TAG}·草稿2发布`, md: `${MD} 第三版。` }, writer);
  check(reEdit.status === 200 && reEdit.json?.reviewStatus === "pending"
    && reEdit.json?.publishedFromDraft === true,
    "带正文的 PUT 即「草稿转正式发布 + 重审」", reEdit.json);

  /* ---------- 5 权限与通知 ---------- */
  console.log("\n## 5 权限与运营通知");
  const byOther = await call(JAVA, "PUT", `/api/articles/${d1.slug}`,
    { title: `${TAG}·别人改`, md: MD }, probe);
  check(byOther.status === 403 && byOther.json?.error === "只能编辑自己的文章", "他人改文 403", byOther.json);
  const delOther = await call(NODE, "DELETE", `/api/articles/${d1.slug}`, undefined, probe);
  check(delOther.status === 403 && delOther.json?.error === "只能撤回自己的文章", "他人撤文 403", delOther.json);
  const noSuch = await call(JAVA, "PUT", "/api/articles/p5-no-such-slug", { title: TAG, md: MD }, writer);
  check(noSuch.status === 404 && noSuch.json?.error === "文章不存在", "改不存在的稿 → 404", noSuch.json);
  const anonPut = await call(NODE, "PUT", `/api/articles/${d1.slug}`, { title: TAG, md: MD });
  check(anonPut.status === 401 && anonPut.json?.error === "请先登录", "未登录 PUT 401");
  const anonDel = await call(JAVA, "DELETE", `/api/articles/${d1.slug}`);
  check(anonDel.status === 401 && anonDel.json?.error === "请先登录", "未登录 DELETE 401");
  await call(NODE, "PUT", `/api/articles/${d1.slug}`, { title: `${TAG}·重审通知`, md: MD }, writer);
  const notices = await many(
    "SELECT user_id AS uid FROM notifications WHERE type = 'review' AND id > ?", [mark.notice]);
  check(notices.length >= 1 && notices.every((n) => Number(n.uid) === adminId),
    "重新提审给每个未封禁的 admin 发一条 review 站内信", `共 ${notices.length} 条`);
  const selfNotice = await num(
    "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND type = 'review' AND id > ?", [writerId, mark.notice]);
  check(selfNotice === 0, "作者自己不收提审通知");

  /* ---------- 6 撤回与硬删 ---------- */
  console.log("\n## 6 撤回（软删）与草稿（硬删 + 子表）");
  const soft = await call(NODE, "DELETE", `/api/articles/${d2.slug}`, undefined, writer);
  check(soft.status === 200 && soft.json?.ok === true && !("deleted" in (soft.json ?? {})),
    "已发布稿撤回只回 ok（没有 deleted 键）", keysOf(soft.json));
  const softRow = await only(
    "SELECT status, pinned, featured FROM articles WHERE slug = ?", [d2.slug]);
  check(softRow?.status === "removed" && Number(softRow?.pinned) === 0 && Number(softRow?.featured) === 0,
    "撤回置 removed 并清置顶/推荐，数据与流水都留着", JSON.stringify(softRow));

  const d3 = await publish(JAVA, writer, { title: `${TAG}·待硬删`, md: MD, draft: true });
  const d3id = await num("SELECT id FROM articles WHERE slug = ?", [d3.slug]);
  // 草稿也能被收藏/评论/浏览/点赞/进专栏 —— 硬删必须先把这些子行清干净，
  // 否则外键 RESTRICT 会挡住主行删除，而先提交的那几条 DELETE 又收不回。
  await conn.query("INSERT INTO comments (article_id, user_id, content) VALUES (?,?,?)", [d3id, probeId, "草稿上的评论"]);
  await conn.query("INSERT INTO bookmarks (user_id, article_id) VALUES (?,?)", [probeId, d3id]);
  await conn.query("INSERT INTO article_likes (user_id, article_id) VALUES (?,?)", [probeId, d3id]);
  await conn.query("INSERT IGNORE INTO read_history (user_id, article_id) VALUES (?,?)", [probeId, d3id]);
  const hard = await call(NODE, "DELETE", `/api/articles/${d3.slug}`, undefined, writer);
  check(hard.status === 200 && hard.json?.deleted === true, "Node 硬删草稿", hard.json);
  check((await num("SELECT COUNT(*) FROM articles WHERE id = ?", [d3id])) === 0, "主行已消失");
  const kidsLeft = await num(`SELECT (SELECT COUNT(*) FROM comments WHERE article_id = ${d3id})
    + (SELECT COUNT(*) FROM bookmarks WHERE article_id = ${d3id})
    + (SELECT COUNT(*) FROM article_likes WHERE article_id = ${d3id})`);
  check(kidsLeft === 0, "子行一并清干净（没有留孤行，也没有部分删除）", String(kidsLeft));

  const d4 = await publish(NODE, writer, { title: `${TAG}·跨栈硬删`, md: MD, draft: true });
  const d4id = await num("SELECT id FROM articles WHERE slug = ?", [d4.slug]);
  await conn.query("INSERT INTO comments (article_id, user_id, content) VALUES (?,?,?)", [d4id, probeId, "Node 种的评论"]);
  const hardJava = await call(JAVA, "DELETE", `/api/articles/${d4.slug}`, undefined, writer);
  check(hardJava.status === 200 && hardJava.json?.deleted === true
    && (await num("SELECT COUNT(*) FROM comments WHERE article_id = ?", [d4id])) === 0,
    "Java 删得掉 Node 种的子行（同一套 article_id 清理口径）", hardJava.json);

  /* ---------- 7 账实 ---------- */
  console.log("\n## 7 账实核对");
  for (const [uid, name, base] of [[writerId, "作者", balWriter], [adminId, "运营", balAdmin]]) {
    const now = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
    const led = await num("SELECT IFNULL(SUM(delta),0) FROM point_ledger WHERE user_id = ? AND id > ?", [uid, mark.ledger]);
    check(now - base === led, `${name}：Δ余额 = ΔΣ流水`, `Δ余额 ${now - base} / Δ流水 ${led}`);
  }
  const reasons = [...new Set((await many(
    "SELECT reason FROM point_ledger WHERE id > ? AND user_id IN (?,?)", [mark.ledger, writerId, adminId])
  ).map((r) => r.reason))];
  check(reasons.every((r) => r === "发布奖励"), "本环节只产生发布奖励这一类流水", reasons);
  const pubs = await num(
    "SELECT cnt FROM reward_counters WHERE user_id = ? AND cap_key = 'publish' AND cnt_day = ?", [writerId, day]);
  check(pubs === 1,
    "「发布奖励」计数停在 1：被上限拒掉的那些次把计数回退了（否则今天的失败会吃掉明天的额度）",
    String(pubs));
  return { writerId, adminId, probeId, day, mark, created: [...created], balWriter, balAdmin };
}

/** 把某个 slug 前缀的残留连子行一起清掉，让"第一/第二篇"这类断言从空位起算。 */
async function purgeSlugPrefix(prefix) {
  const rows = await many("SELECT id FROM articles WHERE slug LIKE ?", [`${prefix}%`]);
  if (!rows.length) return;
  const ids = rows.map((r) => Number(r.id));
  const ph = ids.map(() => "?").join(",");
  for (const t of ["article_boosts", "article_tips", "article_likes", "bookmarks",
    "read_history", "comments", "series_items", "article_purchases"]) {
    await conn.query(`DELETE FROM ${t} WHERE article_id IN (${ph})`, ids);
  }
  await conn.query(`DELETE FROM articles WHERE id IN (${ph})`, ids);
}

/** 距今 n 天的 datetime-local 串（无时区后缀 —— 正是浏览器给的那种）。 */
function futureIso(days) {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function cleanup(c) {
  const ids = [...new Set(c.created.map((x) => Number(x.id)).filter(Boolean))];
  if (ids.length) {
    const ip = ids.map(() => "?").join(",");
    for (const t of ["article_boosts", "article_tips", "article_likes", "bookmarks",
      "read_history", "comments", "series_items", "article_purchases"]) {
      await conn.query(`DELETE FROM ${t} WHERE article_id IN (${ip})`, ids);
    }
    await conn.query(`DELETE FROM articles WHERE id IN (${ip})`, ids);
  }
  // 先量出发了多少奖励，再删流水、再把余额拨回水位
  const paid = {};
  for (const uid of [c.writerId, c.adminId]) {
    paid[uid] = await num(
      "SELECT IFNULL(SUM(delta),0) FROM point_ledger WHERE user_id = ? AND id > ? AND reason = '发布奖励'",
      [uid, c.mark.ledger]);
  }
  await conn.query("DELETE FROM notifications WHERE id > ?", [c.mark.notice]);
  await conn.query("DELETE FROM point_ledger WHERE id > ? AND reason = '发布奖励'", [c.mark.ledger]);
  await conn.query("DELETE FROM reward_counters WHERE user_id IN (?,?) AND cap_key = 'publish' AND cnt_day = ?",
    [c.writerId, c.adminId, c.day]);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [c.balWriter, c.writerId]);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [c.balAdmin, c.adminId]);
  const left = await num("SELECT COUNT(*) FROM articles WHERE title LIKE '闸门稿%'");
  const ledLeft = await num("SELECT COUNT(*) FROM point_ledger WHERE id > ? AND reason = '发布奖励'", [c.mark.ledger]);
  const orphan = await num("SELECT COUNT(*) FROM comments WHERE article_id NOT IN (SELECT id FROM articles)");
  const balWriter = await num("SELECT points_balance FROM users WHERE id = ?", [c.writerId]);
  const balAdmin = await num("SELECT points_balance FROM users WHERE id = ?", [c.adminId]);
  if (left !== 0 || ledLeft !== 0 || orphan !== 0) {
    throw new Error(`清场后仍有残留：文章 ${left} / 流水 ${ledLeft} / 孤评论 ${orphan}`);
  }
  if (balWriter !== c.balWriter || balAdmin !== c.balAdmin) {
    throw new Error(`余额未复原：作者 ${balWriter}≠${c.balWriter} 运营 ${balAdmin}≠${c.balAdmin}`);
  }
  console.log(`（本次发出发布奖励：作者 ${paid[c.writerId]}、运营 ${paid[c.adminId]}，均已回退）`);
}
