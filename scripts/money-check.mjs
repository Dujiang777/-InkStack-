#!/usr/bin/env node
// P4 墨水经济闸门。钱必须有唯一、可核对的去向，所以这里验三件读侧对拍表达不了的事：
//   1) 同一笔写：一侧执行、另一侧看得懂（已购 / 已打包 / 已签 / 已付 的幂等分支跨栈一致）；
//   2) 并发双击不双花：六路同时打两栈，账务只动一次，败者拿到"已成交"或"余额不足"，绝不是一路 500；
//   3) 增量精确：Δ余额 = ΔΣ流水 + 我手工注入的量，且 reason / 金额 / 明细行都等于分账公式的结果。
//
//   node scripts/money-check.mjs          跑完把涉事账号、明细表、夹具全部复原
//   node scripts/money-check.mjs --keep   保留现场（排查用）
//
// 前提：两栈都已启动（Node 3200 / Java 3101），且 DATABASE_URL 指向**克隆库** inkstack_j。
// 本脚本会真扣真加真删，绝不在生产库上跑；中途抛错也会走 finally 清场。
//
// 探针账号取 INK_PROBE_EMAIL：它不持有任何文章/专栏，解锁·打赏·打包的"作者本人"负分支
// 因此不会误命中，清场时按水位删净即可，不碰别人（writer/联调员）的对拍基线。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
// 地址优先级：shell 环境变量 > .env > 默认。写反了会出现"以为在打克隆库、其实在打真库"。
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";
const KEEP = process.argv.includes("--keep");

// 夹具：两篇同作者的付费文 + 一个打包专栏（克隆库里 id 33 / 39 / series 1）
const UNLOCK_SLUG = "qian-duan-xing-neng-you-hua-qing-dan";
const TIP_SLUG = "nei-rong-chuang-zuo-ai-shi-yong-shou-ce";
const SERIES_ID = 1;
const PACK_KEY = "pro";
const TIP_AMOUNT = 10;
const BOOST_COST = 80;
const BADGE_AMOUNT = 100;
const UNLOCK_SHARE = 0.7;

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
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (down) {
    return { status: 0, json: null, text: `${base} 连不上：${down.cause?.code ?? down.message}`, java: false };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 非 JSON 由调用方判定 */ }
  return {
    status: res.status,
    json,
    text,
    // X-Backend 是"这条请求真的由 Java 答的"的硬证据；Node 侧不该带它
    java: res.headers.get("x-backend") === "inkstack-java",
    setCookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ink_session=")),
  };
}

async function login(base, email, password) {
  const r = await call(base, "POST", "/api/auth/login", { email, password });
  if (!r.setCookie) throw new Error(`${base} 登录失败 ${r.status}：${r.text.slice(0, 120)}`);
  return r.setCookie;
}

const hist = (rs) => {
  const h = {};
  for (const x of rs) h[x.status] = (h[x.status] ?? 0) + 1;
  return Object.entries(h).map(([k, v]) => `${k}×${v}`).join(" ");
};
const won = (rs) => rs.filter((x) => x.status === 200 && x.json?.ok === true && x.json?.already !== true);
const idempotent = (rs) => rs.filter((x) => x.status === 200 && x.json?.already === true);
const withStatus = (rs, s) => rs.filter((x) => x.status === s);

/** 并发链路的通用断言：只一路成交，其余全部落进既定分支，一路 500 都不该有。 */
function raceShape(label, rs, losers) {
  check(rs.every((x) => x.status !== 0), `${label}：两栈都活着`, hist(rs));
  check(rs.filter((x) => x.java).length >= 2 && rs.filter((x) => !x.java).length >= 1,
    `${label}：确实两栈各答了一半`, `Java ${rs.filter((x) => x.java).length}/${rs.length}`);
  check(!rs.some((x) => x.status >= 500), `${label}：没有一路 500（无死锁、无静默失败）`, hist(rs));
  check(won(rs).length === 1, `${label}：只有一路真成交`, `${won(rs).length} 路成交 / ${hist(rs)}`);
  check(losers(rs).length === rs.length - 1, `${label}：败者全落进既定分支`, hist(rs));
}

const conn = await mysql.createConnection(env.DATABASE_URL);
const fixtures = { follows: [], checkins: [], slugTag: null };
const manual = new Map();
let ctx = null;

const acct = async (uid) => {
  const [[u]] = await conn.query("SELECT points_balance b FROM users WHERE id = ?", [uid]);
  const [[l]] = await conn.query("SELECT IFNULL(SUM(delta),0) s FROM point_ledger WHERE user_id = ?", [uid]);
  return { balance: Number(u?.b ?? 0), ledger: Number(l.s ?? 0) };
};
const only = async (sql, params = []) => (await conn.query(sql, params))[0][0] ?? null;
const many = async (sql, params = []) => (await conn.query(sql, params))[0];
/** 把余额置成"刚好够 N 次"的额度；差值记进 manual，最后的账实核对才不会被它污染。 */
const setBalance = async (uid, value) => {
  const before = await acct(uid);
  manual.set(uid, (manual.get(uid) ?? 0) + (value - before.balance));
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [value, uid]);
};
/** N 路并发：一半打 Node、一半打 Java，同一个 Cookie（同一身份在两栈之间赛跑）。 */
const race = (method, urlPath, body, cookie, n = 6) => Promise.all(
  Array.from({ length: n }, (_, i) => call(i % 2 ? JAVA : NODE, method, urlPath, body, cookie))
);

try {
  await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 2).join(" | ") ?? e}`);
} finally {
  if (ctx && !KEEP) {
    try {
      await cleanup(ctx);
      console.log(`\n已清场：本次产生的购买/打赏/加热/订单/流水/站内信/夹具全部删除，`
        + `余额还原（探针 ${ctx.baseBuyer.balance}、作者 ${ctx.baseAuthor.balance}）`);
    } catch (e) {
      console.error("清场失败，克隆库可能残留测试数据：", e.message);
      fail++;
    }
  } else if (ctx) {
    console.log(`\n--keep：现场未清理，探针账号 uid=${ctx.buyerId}`);
  }
  await conn.end().catch(() => {});
}
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

/* ==================== 用例主体 ==================== */

async function suit() {
  const today = localDay(new Date());
  const buyerId = Number((await many("SELECT id FROM users WHERE email = ?", [env.INK_PROBE_EMAIL]))[0]?.id ?? 0);
  const authorId = Number((await many("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]))[0]?.id ?? 0);
  if (!buyerId || !authorId) throw new Error(`探针/作者账号缺失：buyer=${buyerId} author=${authorId}`);

  const unlockArt = await only(
    "SELECT id, author_id AS authorId, IFNULL(unlock_price,0) AS price FROM articles WHERE slug = ?", [UNLOCK_SLUG]);
  const tipArt = await only("SELECT id FROM articles WHERE slug = ?", [TIP_SLUG]);
  const series = await only(
    "SELECT id, author_id AS authorId, IFNULL(bundle_price,0) AS price FROM series WHERE id = ?", [SERIES_ID]);
  const ownArticle = await only(
    "SELECT id, slug FROM articles WHERE author_id = ? AND status = 'published' LIMIT 1", [authorId]);
  if (!unlockArt || !tipArt || !series || !ownArticle) throw new Error("克隆库缺少 P4 夹具（付费篇目 / 打包专栏 / 作者已发文）");
  if (unlockArt.price <= 0 || series.price <= 0) throw new Error("夹具篇目必须收费，否则走不到扣款分支");
  if (unlockArt.authorId !== authorId || series.authorId !== authorId) {
    throw new Error("夹具作者与 INK_WRITER_EMAIL 不是同一人，分账断言会算错对象");
  }
  console.log(`# 买家 uid=${buyerId}（探针） 作者 uid=${authorId}`);
  console.log(`# 夹具：解锁篇 ${unlockArt.id} 价 ${unlockArt.price} · 打赏篇 ${tipArt.id} · 专栏 ${series.id} 打包 ${series.price} · 加热篇 ${ownArticle.slug}`);

  const baseBuyer = await acct(buyerId);
  const baseAuthor = await acct(authorId);
  const mark = {};
  // 水位：跑完之后"高于水位的行都是我造的"，删起来精确，不会碰到别人的对拍基线。
  // follows / checkins 没有自增主键，按业务键记录与删除，见 fixtures.follows / fixtures.checkins。
  for (const t of ["article_purchases", "series_purchases", "article_tips", "article_boosts",
    "topup_orders", "notifications", "point_ledger", "agent_qa", "articles"]) {
    mark[t] = Number((await only(`SELECT IFNULL(MAX(id),0) AS m FROM \`${t}\``))?.m ?? 0);
  }
  ctx = { buyerId, authorId, baseBuyer, baseAuthor, mark };

  // 探针账号可能带着历史购买记录：先存后删，跑完原样插回，保证"从未解锁"这一起点
  const savedPurchases = await many("SELECT * FROM article_purchases WHERE user_id = ?", [buyerId]);
  const savedBundles = await many("SELECT * FROM series_purchases WHERE user_id = ?", [buyerId]);
  const savedCheckins = await many("SELECT checkin_date FROM checkins WHERE user_id = ?", [buyerId]);
  ctx.restore = { savedPurchases, savedBundles, savedCheckins };
  await conn.query("DELETE FROM article_purchases WHERE user_id = ?", [buyerId]);
  await conn.query("DELETE FROM series_purchases WHERE user_id = ?", [buyerId]);
  await conn.query("DELETE FROM checkins WHERE user_id = ? AND checkin_date = ?", [buyerId, today]);

  const buyer = await login(NODE, env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD);
  const author = await login(NODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  check((await call(JAVA, "GET", "/api/auth/me", undefined, buyer)).json?.user?.id === buyerId,
    "探针 Cookie 在 Java 侧也认得", "跨栈 Cookie 没生效，后面的用例都失去意义");
  check((await call(JAVA, "GET", "/api/auth/me", undefined, author)).json?.user?.id === authorId,
    "作者 Cookie 在 Java 侧也认得");

  await testUnlock(buyer, buyerId, authorId, unlockArt, mark, today);
  await testTip(buyer, author, buyerId, authorId, tipArt, mark);
  await testBoost(author, buyer, authorId, ownArticle, mark);
  await testBundle(buyer, buyerId, authorId, series, mark);
  await testCheckin(buyer, buyerId, mark, today);
  await testBadge(buyer, buyerId, mark);
  await testTopup(buyer, buyerId, mark);
  await audit(baseBuyer, baseAuthor);
}

/** 1. 单篇解锁：并发不双花 + 幂等分支跨栈一致 */
async function testUnlock(buyer, buyerId, authorId, art, mark) {
  const price = Number(art.price);
  const share = Math.floor(price * UNLOCK_SHARE);
  await setBalance(buyerId, price);
  const b0 = await acct(buyerId);
  const a0 = await acct(authorId);
  const rs = await race("POST", `/api/articles/${UNLOCK_SLUG}/unlock`, {}, buyer);
  const led = await many(
    "SELECT user_id AS uid, delta, reason FROM point_ledger WHERE id > ? AND reason IN ('付费解锁文章','文章被解锁') ORDER BY id",
    [mark.point_ledger]);
  const b1 = await acct(buyerId);
  const a1 = await acct(authorId);
  console.log("\n## 1 单篇解锁");
  raceShape("并发解锁", rs, idempotent);
  const purchases = await many(
    "SELECT price, author_gain AS gain FROM article_purchases WHERE article_id = ? AND user_id = ? AND id > ?",
    [art.id, buyerId, mark.article_purchases]);
  check(purchases.length === 1, "并发解锁只落一条购买记录", `${purchases.length} 条`);
  check(led.length === 2
    && led.some((r) => Number(r.uid) === buyerId && Number(r.delta) === -price && r.reason === "付费解锁文章")
    && led.some((r) => Number(r.uid) === authorId && Number(r.delta) === share && r.reason === "文章被解锁"),
    "流水两笔：买家 -价（付费解锁文章）、作者 +floor(价×0.7)（文章被解锁）", JSON.stringify(led));
  check(b1.balance === 0 && b1.balance - b0.balance === b1.ledger - b0.ledger,
    "买家扣到 0 且增量等于流水（无双花）", `余额 ${b0.balance}→${b1.balance} / 流水 Δ${b1.ledger - b0.ledger}`);
  check(a1.balance - a0.balance === share && a1.ledger - a0.ledger === share,
    "作者入账 = 分账公式且余额与流水同增量", `+${a1.balance - a0.balance}（应 ${share}）`);
  check(Number(purchases[0]?.price) === price && Number(purchases[0]?.gain) === share,
    "占位行的 0 被补齐成真实金额", JSON.stringify(purchases[0]));
  const w = won(rs)[0];
  check(w?.json?.price === price && w?.json?.authorGot === share && w?.json?.balance === 0,
    "成交一路的响应三值精确", JSON.stringify(w?.json));
  for (const [who, base] of [["Java", JAVA], ["Node", NODE]]) {
    const again = await call(base, "POST", `/api/articles/${UNLOCK_SLUG}/unlock`, {}, buyer);
    check(again.status === 200 && again.json?.already === true && again.json?.message === "已解锁过本文",
      `${who} 答"已解锁过"（幂等分支跨栈一致）`, `${again.status} ${again.text.slice(0, 90)}`);
  }
  const after = await acct(buyerId);
  check(after.balance === b1.balance && after.ledger === b1.ledger, "重复解锁不再动账");
  const notes = await many("SELECT id FROM notifications WHERE user_id = ? AND id > ?", [authorId, mark.notifications]);
  check(notes.length >= 1, "解锁给作者发了站内信", `${notes.length} 条`);
}

/** 2. 打赏：一条语句锁双方 + 90/10 分账 + Number 入参语义 */
async function testTip(buyer, author, buyerId, authorId, art, mark) {
  await setBalance(buyerId, TIP_AMOUNT);
  const b0 = await acct(buyerId);
  const a0 = await acct(authorId);
  const rs = await race("POST", `/api/articles/${TIP_SLUG}/tip`, { amount: TIP_AMOUNT }, buyer);
  const b1 = await acct(buyerId);
  const a1 = await acct(authorId);
  const got = Math.floor(TIP_AMOUNT * 0.9);
  console.log("\n## 2 墨水打赏");
  raceShape("并发打赏", rs, (x) => withStatus(x, 402));
  const tips = await many("SELECT id FROM article_tips WHERE article_id = ? AND from_user = ? AND id > ?",
    [art.id, buyerId, mark.article_tips]);
  check(tips.length === 1, "并发打赏只落一条明细", `${tips.length} 条`);
  check(b1.balance === 0 && b1.ledger - b0.ledger === -TIP_AMOUNT,
    "买家扣满且流水只有一笔 -10", `余额 ${b1.balance} / 流水 Δ${b1.ledger - b0.ledger}`);
  check(a1.balance - a0.balance === got && a1.ledger - a0.ledger === got,
    "作者收到 floor(10×0.9)=9 且余额与流水同增量", `+${a1.balance - a0.balance}`);
  check(withStatus(rs, 402).every((x) => /^积分不足（余额 \d+，本次需 10）$/.test(String(x.json?.error))),
    "败者 402 且文案是余额口径", hist(rs));
  const decN = await call(NODE, "POST", `/api/articles/${TIP_SLUG}/tip`, { amount: 10.5 }, buyer);
  const decJ = await call(JAVA, "POST", `/api/articles/${TIP_SLUG}/tip`, { amount: 10.5 }, buyer);
  check(decN.status === 400 && decN.json?.error === decJ.json?.error,
    "小数档位不在档内（Number 语义两栈一致）", `${decJ.status} ${decJ.json?.error}`);
  const strJ = await call(JAVA, "POST", `/api/articles/${TIP_SLUG}/tip`, { amount: String(TIP_AMOUNT) }, buyer);
  check(strJ.status === 402, "字符串 \"10\" 被 Number 接住、进到余额判定", `${strJ.status} ${strJ.text.slice(0, 60)}`);
  const noBody = await call(JAVA, "POST", `/api/articles/${TIP_SLUG}/tip`, undefined, buyer);
  const noBodyNode = await call(NODE, "POST", `/api/articles/${TIP_SLUG}/tip`, undefined, buyer);
  check(noBody.status === 400 && noBody.json?.error === noBodyNode.json?.error,
    "空请求体退化成档位错误而不是 500（两侧都走 req.json catch / 流读失败）",
    `${noBody.status} ${noBody.json?.error}`);
  const selfTip = await call(JAVA, "POST", `/api/articles/${TIP_SLUG}/tip`, { amount: TIP_AMOUNT }, author);
  const selfTipNode = await call(NODE, "POST", `/api/articles/${TIP_SLUG}/tip`, { amount: TIP_AMOUNT }, author);
  check(selfTip.status === 400 && selfTip.json?.error === selfTipNode.json?.error,
    "作者给自己打赏被拒且两栈文案一致", `${selfTip.status} ${selfTip.json?.error}`);
}

/** 3. 加热：只许作者本人、余额只够一次、截止按 24h 叠加 */
async function testBoost(author, buyer, authorId, own, mark) {
  console.log("\n## 3 文章加热");
  const notOwnerJ = await call(JAVA, "POST", `/api/articles/${TIP_SLUG}/boost`, {}, buyer);
  const notOwnerN = await call(NODE, "POST", `/api/articles/${TIP_SLUG}/boost`, {}, buyer);
  check(notOwnerJ.status === 403 && notOwnerJ.json?.error === notOwnerN.json?.error,
    "非作者加热 403 且两栈文案逐字一致", `${notOwnerJ.status} ${notOwnerJ.json?.error}`);
  await setBalance(authorId, BOOST_COST);
  const a0 = await acct(authorId);
  const rs = await race("POST", `/api/articles/${own.slug}/boost`, {}, author, 4);
  const a1 = await acct(authorId);
  raceShape("并发加热", rs, (x) => withStatus(x, 402));
  const rows = await many("SELECT id, boost_until AS until FROM article_boosts WHERE article_id = ? AND id > ?",
    [own.id, mark.article_boosts]);
  check(rows.length === 1, "并发加热只落一条记录", `${rows.length} 条`);
  check(a1.balance === 0 && a1.ledger - a0.ledger === -BOOST_COST,
    "加热扣满 80 且流水一致", `余额 ${a1.balance} / 流水 Δ${a1.ledger - a0.ledger}`);
  check(rows[0] && Math.abs(new Date(rows[0].until).getTime() - (Date.now() + 24 * 3600e3)) < 120e3,
    "新截止 = 现在 + 24h", rows[0] ? String(rows[0].until) : "无记录");
  const iso = won(rs)[0]?.json?.boostUntil;
  check(typeof iso === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso),
    "boostUntil 为 JS 风格 UTC ISO", String(iso));
  check(won(rs)[0]?.json?.cost === BOOST_COST && won(rs)[0]?.json?.balance === 0,
    "成交响应回显 cost/balance", JSON.stringify(won(rs)[0]?.json));
}

/** 4. 打包解锁：按篇 floor 均摊 + 余数给前几篇 + 跨栈读回 */
async function testBundle(buyer, buyerId, authorId, series, mark) {
  console.log("\n## 4 专栏打包解锁");
  // 上一环节的解锁会吃掉专栏里的一篇，先把买家自己名下的购买记录清空：
  // 打包看的是"购买时点的待解锁快照"，不清就只剩一篇，分摊断言失去意义。
  // 这些行连同本环节新写的，都由 cleanup 按水位与快照统一复原。
  await conn.query("DELETE FROM article_purchases WHERE user_id = ?", [buyerId]);
  await conn.query("DELETE FROM series_purchases WHERE user_id = ?", [buyerId]);
  mark.article_purchases = Number((await only("SELECT IFNULL(MAX(id),0) m FROM article_purchases"))?.m ?? 0);
  mark.series_purchases = Number((await only("SELECT IFNULL(MAX(id),0) m FROM series_purchases"))?.m ?? 0);
  const pending = (await many(
    `SELECT a.id FROM series_items si JOIN articles a ON a.id = si.article_id
      WHERE si.series_id = ? AND a.status = 'published' AND a.review_status = 'approved'
            AND IFNULL(a.unlock_price,0) > 0
            AND NOT EXISTS(SELECT 1 FROM article_purchases p WHERE p.article_id = a.id AND p.user_id = ?)
      ORDER BY a.id`, [SERIES_ID, buyerId])).map((x) => Number(x.id));
  if (!check(pending.length >= 2, "打包夹具至少两篇待解锁", `${pending.length} 篇`)) return;
  const price = Number(series.price);
  const base = Math.floor(price / pending.length);
  const rem = price - base * pending.length;
  const shares = pending.map((_, i) => base + (i < rem ? 1 : 0));
  const gain = shares.reduce((s, sh) => s + Math.floor(sh * UNLOCK_SHARE), 0);
  await setBalance(buyerId, price);
  const b0 = await acct(buyerId);
  const a0 = await acct(authorId);
  const r = await call(JAVA, "POST", `/api/series/${SERIES_ID}/bundle`, {}, buyer);
  const b1 = await acct(buyerId);
  const a1 = await acct(authorId);
  check(r.status === 200 && r.json?.ok === true && r.json?.already === false
    && r.json?.unlocked === pending.length && r.json?.price === price && r.json?.authorGot === gain,
    "Java 打包成交，金额与篇数等于分摊结果", `${r.status} ${r.text.slice(0, 140)}`);
  check(r.json?.balance === 0, "成交响应余额为 0（下单前刚好够一次）", String(r.json?.balance));
  const detail = await many(
    "SELECT article_id AS id, price, author_gain AS gain FROM article_purchases WHERE user_id = ? AND id > ? ORDER BY article_id",
    [buyerId, mark.article_purchases]);
  check(detail.length === pending.length
    && detail.reduce((s, x) => s + Number(x.price), 0) === price
    && detail.reduce((s, x) => s + Math.floor(Number(x.price) * UNLOCK_SHARE), 0) === gain,
    "逐篇明细：Σprice = 打包价、Σfloor(price×0.7) = 作者入账",
    detail.map((x) => `${x.id}:${x.price}/${x.gain}`).join(" "));
  check(b1.balance === 0 && b1.ledger - b0.ledger === -price,
    "买家只被扣一次打包价", `余额 ${b1.balance} / 流水 Δ${b1.ledger - b0.ledger}`);
  check(a1.balance - a0.balance === gain && a1.ledger - a0.ledger === gain,
    "作者入账等于逐篇分账之和", `+${a1.balance - a0.balance}（应 ${gain}）`);
  const sp = await only(
    "SELECT price, author_gain AS gain, item_count AS items FROM series_purchases WHERE series_id = ? AND user_id = ? AND id > ?",
    [SERIES_ID, buyerId, mark.series_purchases]);
  check(Number(sp?.price) === price && Number(sp?.gain) === gain && Number(sp?.items) === pending.length,
    "打包单占位行补齐了真值", JSON.stringify(sp));
  const led = await many(
    `SELECT reason, COUNT(*) n FROM point_ledger WHERE id > ? AND reason IN ('专栏打包解锁','专栏被打包解锁') GROUP BY reason`,
    [mark.point_ledger]);
  check(led.length === 2 && led.every((x) => Number(x.n) === 1),
    "打包的两条 reason 各一次", JSON.stringify(led));
  // "已打包购买过 → already"这条幂等分支不是再点一次就能进：pending 为空时两栈都先答
  // "已无待解锁的付费篇目"。它要求"买过之后专栏又上新了一篇付费文"——正是快照语义的场景，
  // 也是唯一能证明"读得懂对面那栈写的打包单"的入口。
  const late = await conn.query(
    `INSERT INTO articles (author_id, slug, title, md_content, status, review_status,
                           unlock_price, published_at)
     VALUES (?, 'p4-bundle-late', 'P4打包后续篇', '正文', 'published', 'approved', 30, NOW())`,
    [authorId]
  );
  const lateId = Number(late[0].insertId);
  await conn.query("INSERT INTO series_items (series_id, article_id, position) VALUES (?, ?, 99)",
    [SERIES_ID, lateId]);
  for (const [who, url] of [["Node", NODE], ["Java", JAVA]]) {
    const snap = await call(url, "POST", `/api/series/${SERIES_ID}/bundle`, {}, buyer);
    check(snap.status === 200 && snap.json?.already === true && snap.json?.unlocked === 0
      && snap.json?.balance === -1,
      `${who} 走"已打包 + 有新篇"的快照幂等分支（不补账、不解锁新篇）`,
      `${snap.status} ${snap.text.slice(0, 120)}`);
  }
  check(Number((await only("SELECT COUNT(*) n FROM series_purchases WHERE series_id = ? AND user_id = ?",
    [SERIES_ID, buyerId]))?.n ?? 0) === 1, "新篇目没有偷偷开出第二张打包单");
  check(Number((await only("SELECT COUNT(*) n FROM article_purchases WHERE user_id = ? AND article_id = ?",
    [buyerId, lateId]))?.n ?? 0) === 0, "后续篇目未被自动解锁（快照语义）");
  await conn.query("DELETE FROM series_items WHERE article_id = ?", [lateId]);
  await conn.query("DELETE FROM articles WHERE id = ?", [lateId]);
  const badId = await call(JAVA, "POST", `/api/series/0/bundle`, {}, buyer);
  const badIdNode = await call(NODE, "POST", `/api/series/0/bundle`, {}, buyer);
  check(badId.status === 404 && badId.json?.error === badIdNode.json?.error,
    "非法专栏 id 两栈同为 404（不进 SQL）", `${badId.status} ${badId.json?.error}`);
}

/** 5. 签到：主键防重放 + 发墨同事务 */
async function testCheckin(buyer, buyerId, mark, today) {
  console.log("\n## 5 每日签到");
  await setBalance(buyerId, 0);
  const b0 = await acct(buyerId);
  const rs = await race("POST", "/api/checkin", undefined, buyer);
  const b1 = await acct(buyerId);
  raceShape("并发签到", rs, idempotent);
  const rows = await many("SELECT 1 AS one FROM checkins WHERE user_id = ? AND checkin_date = ?", [buyerId, today]);
  check(rows.length === 1, "并发签到只落一行", `${rows.length} 行`);
  const led = await many(
    "SELECT delta, reason FROM point_ledger WHERE user_id = ? AND reason LIKE '每日签到%' AND id > ?",
    [buyerId, mark.point_ledger]);
  check(led.length === 1 && [10, 20, 40].includes(Number(led[0].delta)),
    "只发一次墨且档位 ∈ {10,20,40}", JSON.stringify(led));
  check(b1.balance === Number(led[0]?.delta ?? -1) && b1.ledger - b0.ledger === b1.balance - b0.balance,
    "签到增量 = 实发档位 = ΔΣ流水", `余额 ${b0.balance}→${b1.balance}`);
  check(/^每日签到·周期第[1-7]天$/.test(String(led[0]?.reason)),
    "reason 带周期天数（对账时能还原档位）", String(led[0]?.reason));
  const gJ = await call(JAVA, "GET", "/api/checkin", undefined, buyer);
  const gN = await call(NODE, "GET", "/api/checkin", undefined, buyer);
  check(gJ.json?.checkedInToday === true && gN.json?.checkedInToday === true, "两栈 GET 都认得这行签到");
  check(JSON.stringify(gJ.json) === JSON.stringify(gN.json),
    "签到状态逐字一致（含 streak/cycleDay/reward/next/balance）", JSON.stringify(gJ.json));
  const w = won(rs)[0]?.json;
  check(w && gJ.json?.streak === w.streak && gJ.json?.cycleDay === w.cycleDay
    && JSON.stringify(gJ.json?.next) === JSON.stringify(w.next),
    "GET 与 POST 的连签/周期/下一档自洽", `streak=${w?.streak} cycle=${w?.cycleDay}`);
  check(idempotent(rs).every((x) => x.json?.streak === w?.streak && x.json?.cycleDay === w?.cycleDay),
    "already 分支重算的状态与成交一路一致", hist(rs));
}

/** 6. 徽章：集齐才发、发过不再发（含跨栈"还差几枚"口径与跨栈判重） */
async function testBadge(buyer, buyerId, mark) {
  console.log("\n## 6 集齐徽章奖励");
  const beforeJ = await call(JAVA, "POST", "/api/me/badge-claim", {}, buyer);
  const beforeN = await call(NODE, "POST", "/api/me/badge-claim", {}, buyer);
  check(beforeN.status === beforeJ.status && beforeN.json?.error === beforeJ.json?.error,
    "未集齐时两栈'还差几枚'逐字一致（连签与余额两项都参与判定）",
    `node=${beforeN.json?.error} java=${beforeJ.json?.error}`);

  // 临时把探针账号刷成"全成就"：10 篇过发文 + 7 天连签 + 关注关系 + 分身问答 + 余额。
  // 判定项与 lib/data.ts listAchievements 的 14 个阈值一一对应，缺一项就测不到发放分支。
  const slugTag = `${Date.now()}`;
  await conn.query(
    `INSERT INTO articles (author_id, slug, title, md_content, status, review_status,
                           read_count, like_count, comment_count, published_at)
     VALUES ${Array.from({ length: 10 }, (_, i) =>
      `(${buyerId}, ${conn.escape(`p4-badge-${i}-${slugTag}`)}, 'P4徽章夹具${i}', '正文',
        'published', 'approved', 200, 10, 5, NOW())`).join(",")}`
  );
  fixtures.slugTag = slugTag;
  await conn.query(
    `INSERT INTO agent_qa (asker_id, question, answer) VALUES ${
      Array.from({ length: 10 }, () => `(${buyerId}, 'p4 夹具问题', 'p4 夹具回答')`).join(",")}`
  );
  const peers = (await many("SELECT id FROM users WHERE id <> ? ORDER BY id LIMIT 8", [buyerId])).map((u) => Number(u.id));
  // INSERT IGNORE：探针账号本来就可能已有关注关系，撞了唯一键就跳过，
  // 且只把"这次真插进去的"记进夹具——否则清场会连别人的关注一起删掉。
  const follow = async (from, to) => {
    const r = await conn.query("INSERT IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)", [from, to]);
    if (Number(r[0].affectedRows) === 1) fixtures.follows.push([from, to]);
  };
  for (const p of peers.slice(0, 3)) await follow(buyerId, p); // 以文会友：关注 3 位
  for (const p of peers.slice(0, 5)) await follow(p, buyerId); // 众望所归：5 位粉丝
  if (peers.length < 5) throw new Error(`库里可用用户不足 5 个，凑不出粉丝徽章：${peers.length}`);
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = localDay(d);
    await conn.query("INSERT INTO checkins (user_id, checkin_date) VALUES (?, ?)", [buyerId, day]);
    fixtures.checkins.push(day);
  }
  await setBalance(buyerId, 1200);

  // 不预先单独领一次：判重键是流水 reason，一旦发出去就再也测不到并发那一幕。
  // 直接六路并发，既验"只发一次"，也顺带让另一栈读到这条流水（跨栈判重）。
  const b0 = await acct(buyerId);
  const rs = await race("POST", "/api/me/badge-claim", {}, buyer);
  const b1 = await acct(buyerId);
  raceShape("并发领取徽章奖励", rs, (x) => withStatus(x, 409));
  const led = await many(
    "SELECT delta, reason FROM point_ledger WHERE user_id = ? AND reason = '集齐徽章奖励' AND id > ?",
    [buyerId, mark.point_ledger]);
  check(led.length === 1 && Number(led[0].delta) === BADGE_AMOUNT,
    "100 滴墨只发一次", JSON.stringify(led));
  check(b1.balance - b0.balance === BADGE_AMOUNT && b1.ledger - b0.ledger === BADGE_AMOUNT,
    "领取增量 = 档位 = ΔΣ流水", `${b0.balance}→${b1.balance}`);
  const w = won(rs)[0]?.json;
  check(w?.amount === BADGE_AMOUNT && w?.balance === b1.balance
    && /集齐 14 枚徽章/.test(String(w?.message)),
    "成交响应三值精确（amount / balance / 文案）", JSON.stringify(w));
  for (const [who, base] of [["Node", NODE], ["Java", JAVA]]) {
    const again = await call(base, "POST", "/api/me/badge-claim", {}, buyer);
    check(again.status === 409 && again.json?.error === "奖励已经领取过啦",
      `${who} 认得这条领取流水（reason 是跨栈业务键）`, `${again.status} ${again.text.slice(0, 70)}`);
  }
  check((await acct(buyerId)).balance === b1.balance, "重复领取不再动账");
}

/** 7. 充值：下单、状态机幂等、跨栈消费 */
async function testTopup(buyer, buyerId, mark) {
  console.log("\n## 7 充值到账");
  const packsN = await call(NODE, "GET", "/api/topup/orders");
  const packsJ = await call(JAVA, "GET", "/api/topup/orders");
  check(JSON.stringify(packsN.json) === JSON.stringify(packsJ.json),
    "套餐表两栈逐字一致（同一份常量的两个副本）", `${packsJ.json?.packs?.length ?? "?"} 个套餐`);
  const pack = (packsJ.json?.packs ?? []).find((p) => p.key === PACK_KEY);
  if (!check(!!pack, `常量表里有 ${PACK_KEY} 套餐`, JSON.stringify(packsJ.json?.packs))) return;
  const o = await call(JAVA, "POST", "/api/topup/orders", { packKey: PACK_KEY }, buyer);
  check(o.status === 200 && /^TP\d{14}[0-9A-Z]{1,4}$/.test(String(o.json?.orderNo)),
    "Java 下单：号形如 TP+14 位时间+base36", String(o.json?.orderNo));
  check(JSON.stringify(o.json?.pack) === JSON.stringify(pack), "下单回显的套餐与常量表一致");
  await setBalance(buyerId, 0);
  const b0 = await acct(buyerId);
  const rs = await Promise.all([
    call(NODE, "POST", "/api/topup/pay", { orderNo: o.json.orderNo, channel: "wechat" }, buyer),
    call(JAVA, "POST", "/api/topup/pay", { orderNo: o.json.orderNo }, buyer),
    call(NODE, "POST", "/api/topup/pay", { orderNo: o.json.orderNo }, buyer),
    call(JAVA, "POST", "/api/topup/pay", { orderNo: o.json.orderNo }, buyer),
  ]);
  const b1 = await acct(buyerId);
  raceShape("并发支付", rs, (x) => withStatus(x, 400));
  check(b1.balance === pack.points && b1.ledger - b0.ledger === pack.points,
    "到账只一次且等于套餐点数", `余额 ${b1.balance} / 应 ${pack.points}`);
  const w = won(rs)[0]?.json;
  check(w?.points === pack.points && w?.balance === pack.points,
    "支付响应回显点数与到账后余额", JSON.stringify(w));
  const row = await only("SELECT status, channel FROM topup_orders WHERE order_no = ?", [o.json.orderNo]);
  check(row?.status === "paid" && ["demo", "wechat"].includes(row?.channel),
    "订单落为 paid 且记录了成交那一路自报的渠道", JSON.stringify(row));
  // 渠道值单独串行验一次：并发里赢的是哪一路不确定，用它来断言 channel 会随机红
  const o3 = await call(NODE, "POST", "/api/topup/orders", { packKey: PACK_KEY }, buyer);
  await call(NODE, "POST", "/api/topup/pay", { orderNo: o3.json?.orderNo, channel: "alipay" }, buyer);
  const row3 = await only("SELECT status, channel FROM topup_orders WHERE order_no = ?", [o3.json?.orderNo]);
  check(row3?.status === "paid" && row3?.channel === "alipay",
    "渠道按客户端自报值原样记录（仅记账，不代表验签）", JSON.stringify(row3));
  check(withStatus(rs, 400).every((x) => x.json?.error === "订单已支付或已关闭"),
    "重复支付一律被状态机拒", hist(rs));
  const o2 = await call(NODE, "POST", "/api/topup/orders", { packKey: PACK_KEY }, buyer);
  const cross = await call(JAVA, "POST", "/api/topup/pay", { orderNo: o2.json?.orderNo }, buyer);
  check(cross.status === 200 && cross.json?.ok === true,
    "Node 下的单 Java 能到账", `${cross.status} ${cross.text.slice(0, 110)}`);
  const led = await many(
    "SELECT delta, reason FROM point_ledger WHERE user_id = ? AND reason LIKE '充值到账·%' AND id > ?",
    [buyerId, mark.point_ledger]);
  // 本环节一共到账三单：并发那一单 + 渠道专用一单 + 跨栈消费一单
  check(led.length === 3 && led.every((x) => Number(x.delta) === pack.points && /·创作者包$/.test(x.reason)),
    "每单一条流水，reason 带套餐名（对账能看出买了哪档）", JSON.stringify(led));
  const foreign = await call(JAVA, "POST", "/api/topup/pay", { orderNo: "TP00000000000000ZZZZ" }, buyer);
  check(foreign.status === 400 && foreign.json?.error === "订单不存在",
    "不存在 / 别人的订单一律答'不存在'", `${foreign.status} ${foreign.json?.error}`);
  const badPack = await call(JAVA, "POST", "/api/topup/orders", { packKey: "nope" }, buyer);
  check(badPack.status === 400 && badPack.json?.error === "套餐不存在", "未知套餐 400");
  const noOrder = await call(JAVA, "POST", "/api/topup/pay", {}, buyer);
  check(noOrder.status === 400 && noOrder.json?.error === "缺少订单号", "缺订单号先于任何 SQL 被拒");
}

/** 8. 全链路账实核对：每一滴墨的移动都要么有流水、要么是我手工注入的 */
async function audit(baseBuyer, baseAuthor) {
  console.log("\n## 8 账实核对");
  for (const [label, uid, base] of [["买家", ctx.buyerId, baseBuyer], ["作者", ctx.authorId, baseAuthor]]) {
    const now = await acct(uid);
    const injected = manual.get(uid) ?? 0;
    check(now.balance - base.balance === now.ledger - base.ledger + injected,
      `${label}：Δ余额 = ΔΣ流水 + 手工注入量`,
      `Δ余额 ${now.balance - base.balance} / Δ流水 ${now.ledger - base.ledger} / 注入 ${injected}`);
  }
}

/* ==================== 清场 ==================== */

async function cleanup(c) {
  const { buyerId, authorId, baseBuyer, baseAuthor, mark, restore } = c;
  await conn.query("DELETE FROM article_purchases WHERE user_id = ? AND id > ?", [buyerId, mark.article_purchases]);
  await conn.query("DELETE FROM series_purchases WHERE user_id = ? AND id > ?", [buyerId, mark.series_purchases]);
  await conn.query("DELETE FROM article_tips WHERE from_user = ? AND id > ?", [buyerId, mark.article_tips]);
  await conn.query("DELETE FROM article_boosts WHERE id > ?", [mark.article_boosts]);
  await conn.query("DELETE FROM topup_orders WHERE user_id = ? AND id > ?", [buyerId, mark.topup_orders]);
  await conn.query("DELETE FROM notifications WHERE user_id IN (?, ?) AND id > ?", [buyerId, authorId, mark.notifications]);
  await conn.query("DELETE FROM point_ledger WHERE user_id IN (?, ?) AND id > ?", [buyerId, authorId, mark.point_ledger]);
  await conn.query("DELETE FROM agent_qa WHERE asker_id = ? AND question LIKE 'p4 夹具%' AND id > ?",
    [buyerId, mark.agent_qa]);
  if (fixtures.slugTag) {
    await conn.query("DELETE FROM articles WHERE author_id = ? AND slug LIKE ?", [buyerId, `p4-badge-%-${fixtures.slugTag}`]);
  }
  for (const [a, b] of fixtures.follows) {
    await conn.query("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?", [a, b]);
  }
  for (const day of fixtures.checkins) {
    await conn.query("DELETE FROM checkins WHERE user_id = ? AND checkin_date = ?", [buyerId, day]);
  }
  await conn.query("DELETE FROM checkins WHERE user_id = ? AND checkin_date = CURDATE()", [buyerId]);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [baseBuyer.balance, buyerId]);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [baseAuthor.balance, authorId]);
  await conn.query("DELETE FROM article_purchases WHERE user_id = ?", [buyerId]);
  await conn.query("DELETE FROM series_purchases WHERE user_id = ?", [buyerId]);
  await conn.query("DELETE FROM checkins WHERE user_id = ?", [buyerId]);
  for (const r of restore.savedPurchases) {
    await conn.query(
      `INSERT INTO article_purchases (article_id, user_id, price, author_gain, created_at)
       VALUES (?, ?, ?, ?, ?)`, [r.article_id, r.user_id, r.price, r.author_gain, r.created_at]);
  }
  for (const r of restore.savedBundles) {
    await conn.query(
      `INSERT INTO series_purchases (series_id, user_id, price, author_gain, item_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r.series_id, r.user_id, r.price, r.author_gain, r.item_count, r.created_at]);
  }
  for (const r of restore.savedCheckins) {
    await conn.query("INSERT INTO checkins (user_id, checkin_date) VALUES (?, ?)", [buyerId, r.checkin_date]);
  }
  const left = await only(
    `SELECT (SELECT COUNT(*) FROM article_purchases WHERE user_id = ${buyerId} AND id > ${mark.article_purchases}) purchases,
            (SELECT COUNT(*) FROM point_ledger WHERE user_id IN (${buyerId},${authorId}) AND id > ${mark.point_ledger}) ledger,
            (SELECT COUNT(*) FROM articles WHERE slug LIKE 'p4-badge-%') fixture_articles,
            (SELECT points_balance FROM users WHERE id = ${buyerId}) buyer_balance`);
  if (left.purchases || left.ledger || left.fixture_articles) {
    throw new Error(`清场不彻底：${JSON.stringify(left)}`);
  }
}
