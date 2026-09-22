#!/usr/bin/env node
// P5 社区互动闸门（第一批：评论 / 点赞 / 收藏 / 关注 / 举报 / 站内信）。
//
// 这六条链路各有一个"读侧对拍测不出"的洞，所以这里真写、真并发、真清场：
//   1) 跨栈看得懂：一侧发的评论另一侧读得到，一侧标的已读另一侧的未读数跟着降。
//   2) 并发不炸且不重复：点赞/收藏/评论点赞/关注/举报各打六路两栈，零 500，关系行至多一行。
//   3) 奖励有上限且不吞额度：评论 +1/日 3 次，第 4 次必须被拒且**计数回退**
//      （不回退的话，今天被拒的那几次也会占掉额度，用户明天就"莫名其妙领不到"）。
//   4) 举报防重靠的是锁而不是唯一键：reports 表上确实没有 (reporter,target) 唯一索引，
//      "先查后插"两句之间无锁就是 20 并发落十几行——只有并发打才看得出来。
//   5) 计数字段与关系行数守恒：like_count = COUNT(article_likes)，无论并发最后落在哪一侧。
//
//   node scripts/community-check.mjs          跑完把涉事数据全部复原
//   node scripts/community-check.mjs --keep   保留现场（排查用）
//
// 前提：两栈都已启动（Node 3200 / Java 3101），且 DATABASE_URL 指向**克隆库** inkstack_j。
// 一次约 150 个请求，贴着边缘限流（每 IP 120 次/分）的上沿跑：**连跑要隔一分钟**，
// 否则第二轮起会被 429 打挂一片，那种红不是代码的问题。
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

const RUN = new Date().toISOString().slice(11, 19).replace(/:/g, "");
// slug 带时间戳：付费墙埋点的去重窗口活在进程内存里（Node 的 globalThis.__inkPaywallSeen），
// 同一台机器 30 分钟内连跑两次会复用同一个键，第二次直接判"已计过"——那是闸门的坑不是代码的坑。
const FIX = `p5-community-fixture-${RUN}`;
const DRAFT = `p5-community-draft-${RUN}`;
const REP = `p5-community-report-${RUN}`;

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
  return {
    status: res.status, json, text,
    // X-Backend 是"这条请求确实由 Java 应答"的硬证据；Node 侧不该带它
    java: res.headers.get("x-backend") === "inkstack-java",
  };
}

async function login(base, email, password) {
  const r = await call(base, "POST", "/api/auth/login", { email, password });
  if (r.status !== 200) throw new Error(`${base} 登录失败 ${r.status}：${r.text.slice(0, 120)}`);
  // 直连两栈时 Java 也下发 Set-Cookie，这里只取会话那一条
  const raw = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (raw.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error(`${base} 登录未下发 ink_session`);
  return cookie;
}

const hist = (rs) => {
  const h = {};
  for (const x of rs) h[x.status] = (h[x.status] ?? 0) + 1;
  return Object.entries(h).map(([k, v]) => `${k}×${v}`).join(" ");
};
/** N 路并发：一半打 Node、一半打 Java，同一个 Cookie（同一身份在两栈之间赛跑）。 */
const race = (method, urlPath, body, cookie, n = 6) => Promise.all(
  Array.from({ length: n }, (_, i) => call(i % 2 ? JAVA : NODE, method, urlPath, body, cookie))
);
function raceAlive(label, rs) {
  check(rs.every((x) => x.status !== 0), `${label}：两栈都活着`, hist(rs));
  check(rs.filter((x) => x.java).length >= 2 && rs.filter((x) => !x.java).length >= 1,
    `${label}：确实两栈各答了一半`, `Java ${rs.filter((x) => x.java).length}/${rs.length}`);
  check(!rs.some((x) => x.status >= 500), `${label}：没有一路 500（无死锁、无静默失败）`, hist(rs));
}

const conn = await mysql.createConnection(env.DATABASE_URL);
const only = async (sql, params = []) => (await conn.query(sql, params))[0][0] ?? null;
const many = async (sql, params = []) => (await conn.query(sql, params))[0];
const num = async (sql, params = []) => {
  const row = await only(sql, params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? 0 : Number(v);
};

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
      console.log("\n已清场：夹具文章、评论、点赞、收藏、关注、举报、站内信、奖励流水与计数全部还原");
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
  const probeId = await num("SELECT id FROM users WHERE email = ?", [env.INK_PROBE_EMAIL]);
  const writerId = await num("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]);
  if (!probeId || !writerId) throw new Error(`探针/作者账号缺失：probe=${probeId} writer=${writerId}`);
  const probe = await login(NODE, env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD);
  const writer = await login(NODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  check(true, `登录：探针 uid=${probeId} 作者 uid=${writerId}`);

  if (await num("SELECT id FROM articles WHERE slug = ?", [FIX])) {
    throw new Error(`夹具已存在，说明上次没清干净：${FIX}`);
  }
  const artId = await createArticle(writerId, FIX, "P5 社区闸门·正文", "published", 30);
  const draftId = await createArticle(writerId, DRAFT, "P5 社区闸门·草稿", "draft", 0);
  const repId = await createArticle(writerId, REP, "P5 社区闸门·待举报", "published", 0);

  const mark = {
    comment: await num("SELECT IFNULL(MAX(id),0) FROM comments"),
    notice: await num("SELECT IFNULL(MAX(id),0) FROM notifications"),
    report: await num("SELECT IFNULL(MAX(id),0) FROM reports"),
    ledger: await num("SELECT IFNULL(MAX(id),0) FROM point_ledger"),
  };
  const balProbe = await num("SELECT points_balance FROM users WHERE id = ?", [probeId]);
  const balWriter = await num("SELECT points_balance FROM users WHERE id = ?", [writerId]);
  const ctxLocal = { probeId, writerId, artId, draftId, repId, day, mark, balProbe, balWriter };
  // 作者本来的未读通知：环节 8 会"全部已读"，清场时得把 is_read 拨回去
  ctxLocal.wasUnread = (await many(
    "SELECT id FROM notifications WHERE user_id = ? AND is_read = 0", [writerId])).map((r) => r.id);

  /* ---------- 1 评论发表 ---------- */
  console.log("\n## 1 评论发表");
  // 期望值随每次调用累加，不写死常数——写死的数字一改用例就得手算，那种断言最先说谎。
  //   probePaid：探针作为发评人拿到 +1 的次数（日上限 3）
  //   authorPaid：作者作为"被评论"拿到 +2 的次数（日上限 10；游客评论也发，作者自评不发）
  let posted = 0;
  let probePaid = 0;
  let authorPaid = 0;
  const ok1 = await call(NODE, "POST", `/api/articles/${FIX}/comments`, { content: "闸门评论甲" }, probe);
  posted++; probePaid++; authorPaid++;
  check(ok1.status === 200 && ok1.json?.ok === true && ok1.json?.asUser === true,
    "Node 发评论成功且标记为登录态", hist([ok1]));
  const row = ok1.json?.comment;
  check(typeof row?.id === "number" && row?.content === "闸门评论甲" && row?.nickname
    && row?.likes === 0 && row?.viewerLiked === false && row?.parentId === null
    && row?.createdAt && typeof row?.createdAt === "string",
    "回显的真实评论行形状正确（前端靠它替换占位行，缺 id 会让新评论点赞 404）", row);
  const javaSees = await call(JAVA, "GET", `/api/articles/${FIX}/comments`, undefined, probe);
  check(javaSees.status === 200 && javaSees.json?.comments?.some((c) => c.id === row?.id),
    "Java 的评论列表读得到 Node 刚写的那条");
  const ok2 = await call(JAVA, "POST", `/api/articles/${FIX}/comments`,
    { content: "闸门评论乙", parentId: row?.id }, probe);
  posted++; probePaid++; authorPaid++;
  check(ok2.status === 200 && ok2.json?.comment?.parentId === row?.id,
    "Java 发带父的回复成功，parentId 原样回显", ok2.json?.comment);
  check(ok2.json?.comment?.parentAuthor === "联调员" || ok2.json?.comment?.parentAuthor === "访客"
    || typeof ok2.json?.comment?.parentAuthor === "string",
    "父评论昵称回查（回复对象是探针自己发的）", ok2.json?.comment?.parentAuthor);
  const nodeAgain = await call(NODE, "GET", `/api/articles/${FIX}/comments`, undefined, probe);
  const javaAgain = await call(JAVA, "GET", `/api/articles/${FIX}/comments`, undefined, probe);
  const shape = (r) => JSON.stringify((r.json?.comments ?? []).map((c) =>
    [c.id, c.nickname, c.content, c.parentId ?? null, c.parentAuthor ?? null, c.likes, c.viewerLiked]));
  check(nodeAgain.status === 200 && shape(nodeAgain) === shape(javaAgain),
    "两栈的评论列表逐字一致（含 viewerLiked 的 int→bool）", shape(javaAgain).slice(0, 180));

  const guest = await call(NODE, "POST", `/api/articles/${FIX}/comments`,
    { nickname: "闸门游客", content: "游客也有一条" });
  posted++; authorPaid++;
  check(guest.status === 200 && guest.json?.asUser === false && guest.json?.comment?.nickname === "闸门游客",
    "游客可评论，昵称走 guest_nickname", guest.json?.comment);
  const guestJava = await call(JAVA, "POST", `/api/articles/${FIX}/comments`,
    { nickname: "  闸门游客乙  ", content: "游客乙" });
  posted++; authorPaid++;
  check(guestJava.json?.comment?.nickname === "闸门游客乙",
    "昵称两侧空白被裁掉（Java 与 JS 的 trim 同口径）", guestJava.json?.comment?.nickname);
  const blankJava = await call(JAVA, "POST", `/api/articles/${FIX}/comments`, { nickname: "x", content: " 　  " });
  const blankNode = await call(NODE, "POST", `/api/articles/${FIX}/comments`, { nickname: "x", content: " 　  " });
  check(blankNode.status === 400 && blankNode.json?.error === "评论内容不能为空"
    && blankJava.status === 400 && blankJava.json?.error === "评论内容不能为空",
    "纯空白（含全角空格 U+3000）两栈都判「不能为空」——Java 的 trim() 裁不掉它，必须按 JS 口径裁",
    `${blankNode.json?.error} / ${blankJava.json?.error}`);
  const tooLong = await call(JAVA, "POST", `/api/articles/${FIX}/comments`, { content: "甲".repeat(1001) });
  check(tooLong.status === 400 && tooLong.json?.error === "评论最长 1000 字", "超长 1001 字被拒");
  const edge = await call(NODE, "POST", `/api/articles/${FIX}/comments`, { content: "甲".repeat(1000) }, probe);
  posted++; probePaid++; authorPaid++;
  check(edge.status === 200, "刚好 1000 字放行（边界两侧同判）", edge.status);

  const ghost = await call(JAVA, "POST", `/api/articles/${REP}/comments`,
    { content: "跨文串楼", parentId: row?.id }, probe);
  check(ghost.status === 400 && ghost.json?.error === "要回复的评论不存在或已删除",
    "父评论不属于本文 → 拒（防跨文串楼）", ghost.json?.error);
  const halfNode = await call(NODE, "POST", `/api/articles/${FIX}/comments`,
    { content: "小数楼", parentId: (row?.id ?? 0) + 0.5 }, probe);
  const halfJava = await call(JAVA, "POST", `/api/articles/${FIX}/comments`,
    { content: "小数楼", parentId: (row?.id ?? 0) + 0.5 }, probe);
  check(halfNode.status === 400 && halfJava.status === 400
    && halfNode.json?.error === halfJava.json?.error,
    "parentId 给 12.5 这类小数，两栈同判「不存在」而不是各自取整后命中 12 楼",
    `${halfNode.json?.error} / ${halfJava.json?.error}`);
  const draftJava = await call(JAVA, "POST", `/api/articles/${DRAFT}/comments`, { content: "给草稿评论" });
  const draftNode = await call(NODE, "POST", `/api/articles/${DRAFT}/comments`, { content: "给草稿评论" }, probe);
  check(draftJava.status === 400 && draftNode.status === 400
    && draftJava.json?.error === "文章不存在或未公开，无法评论",
    "草稿不许评论（INSERT..SELECT 把 published 条件压进同一条语句，所以零行即拒）", draftJava.json?.error);
  const missing = await call(JAVA, "POST", "/api/articles/p5-not-here/comments", { content: "无此篇" }, probe);
  check(missing.status === 400 && missing.json?.error === "文章不存在或未公开，无法评论", "不存在的 slug 同判");
  const counted = await num("SELECT comment_count FROM articles WHERE id = ?", [artId]);
  check(counted === posted, `comment_count 恰好等于成功发评论的次数（${posted} 次）`, `库 ${counted}`);
  const badCounted = await num(
    "SELECT comment_count FROM articles WHERE id IN (?,?)", [draftId, repId]);
  check(badCounted === 0, "失败分支一次都不碰计数（草稿与举报篇都没被评论）", String(badCounted));

  /* ---------- 2 评论奖励与日上限 ---------- */
  console.log("\n## 2 评论奖励与日上限");
  const probeLed = () => many(
    "SELECT delta, reason FROM point_ledger WHERE user_id = ? AND id > ? AND reason IN ('评论互动','文章被评论') ORDER BY id",
    [probeId, mark.ledger]);
  const mine = await probeLed();
  check(mine.filter((r) => r.reason === "评论互动").length === probePaid
    && mine.every((r) => Number(r.delta) === 1),
    `探针实发 ${probePaid} 条 +1 流水，reason 逐字为「评论互动」`, JSON.stringify(mine));
  check(ok1.json?.rewards?.commentator === 1 && ok1.json?.rewards?.author === 2,
    "首条评论同时给作者发 +2（rewards 两个键都在）", ok1.json?.rewards);
  const authorLed = await num(
    "SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND reason = '文章被评论' AND id > ?",
    [writerId, mark.ledger]);
  check(authorLed === authorPaid,
    `作者实收 ${authorPaid} 条 +2（游客评论也发，因为发的是"文章被评论"这件事）`, String(authorLed));

  // 探针的 +1 已经发了 probePaid 次（=上限 3）；作者还差几轮到上限 10。
  const caps = [];
  for (let i = 0; i < 5; i++) {
    caps.push(await call(i % 2 ? JAVA : NODE, "POST", `/api/articles/${FIX}/comments`,
      { content: `上限压测${i}` }, probe));
    posted++;
    authorPaid++;
  }
  check(caps.every((c) => c.status === 200 && c.json?.ok === true), "压测的评论本身照发", hist(caps));
  const cnt = await only(
    "SELECT cnt FROM reward_counters WHERE user_id = ? AND cap_key = 'comment' AND cnt_day = ?",
    [probeId, day]);
  check(Number(cnt?.cnt) === 3,
    "「评论互动」计数恰好停在 3：被拒的那几次把计数回退了（否则今天的失败会吃掉明天的额度）",
    JSON.stringify(cnt));
  const still = await num(
    "SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND reason = '评论互动' AND id > ?",
    [probeId, mark.ledger]);
  check(still === 3, `上限之后不再发：${still} 条 / 应 3 条`);
  const authorCnt = await only(
    "SELECT cnt FROM reward_counters WHERE user_id = ? AND cap_key = 'comment_received' AND cnt_day = ?",
    [writerId, day]);
  check(Number(authorCnt?.cnt) === 10,
    "作者的「被评论」计数停在 10（第 11 次被拒并回退）", JSON.stringify(authorCnt));
  const over = await call(NODE, "POST", `/api/articles/${FIX}/comments`, { content: "超上限还发" }, probe);
  posted++;
  check(over.status === 200 && over.json?.ok === true && over.json?.rewards?.commentator === undefined
    && over.json?.rewards?.author === undefined,
    "两个上限都满后：评论仍成功，但 rewards 退化成空对象", over.json?.rewards);
  const selfComment = await call(JAVA, "POST", `/api/articles/${FIX}/comments`, { content: "作者自评" }, writer);
  posted++;
  check(selfComment.status === 200 && selfComment.json?.rewards?.author === undefined,
    "作者评自己的文章不给作者发钱（防自刷）", selfComment.json?.rewards);
  const countedNow = await num("SELECT comment_count FROM articles WHERE id = ?", [artId]);
  check(countedNow === posted, `计数仍与成功评论数一致（${posted} 条）`, `库 ${countedNow}`);

  /* ---------- 3 文章点赞 ---------- */
  console.log("\n## 3 文章点赞（toggle + 并发计数守恒）");
  const like1 = await call(NODE, "POST", `/api/articles/${FIX}/like`, undefined, probe);
  check(like1.status === 200 && like1.json?.liked === true && like1.json?.likeCount === 1,
    "Node 首点赞 → liked:true 且计数 1", like1.json);
  const like2 = await call(JAVA, "POST", `/api/articles/${FIX}/like`, undefined, probe);
  check(like2.status === 200 && like2.json?.liked === false && like2.json?.likeCount === 0,
    "Java 再点一次即取消（同一关系行跨栈可见）", like2.json);
  const like3 = await call(JAVA, "POST", `/api/articles/${FIX}/like`, undefined, probe);
  check(like3.json?.liked === true && like3.json?.likeCount === 1, "再点回来", like3.json);
  const raceLike = await race("POST", `/api/articles/${REP}/like`, undefined, probe, 6);
  raceAlive("并发点赞", raceLike);
  const likeRows = await num("SELECT COUNT(*) FROM article_likes WHERE article_id = ?", [repId]);
  check(likeRows <= 1, "同一人对同一篇的关系行至多一行（主键挡住并发）", String(likeRows));
  const likeCnt = await num("SELECT like_count FROM articles WHERE id = ?", [repId]);
  check(likeCnt === likeRows,
    "like_count 与关系行数守恒：并发后不论落在哪个终态，展示数字都不会与库脱节",
    `计数 ${likeCnt} / 行 ${likeRows}`);
  check(likeCnt >= 0, "计数不为负（GREATEST(0,…) 兜住了并发的减）", String(likeCnt));
  // 并发 toggle 的终态本身不确定（可能落在"已赞"也可能落在"未赞"），所以这里不猜，
  // 只按当前状态把它拨回零——拨的动作顺带再验一次跨栈 toggle 认得对方写的行。
  if ((await num("SELECT like_count FROM articles WHERE id = ?", [repId])) > 0) {
    const cancel = await call(NODE, "POST", `/api/articles/${REP}/like`, undefined, probe);
    check(cancel.status === 200 && cancel.json?.liked === false && cancel.json?.likeCount === 0,
      "并发后由 Node 取消，计数归零", cancel.json);
  } else {
    const unlike = await call(NODE, "POST", `/api/articles/${REP}/like`, undefined, probe);
    const back = await call(JAVA, "POST", `/api/articles/${REP}/like`, undefined, probe);
    check(unlike.json?.liked === true && back.json?.liked === false && back.json?.likeCount === 0,
      "并发后落在未赞态：Node 赞上、Java 取消，计数回到零", back.json);
  }
  const draftLike = await call(JAVA, "POST", `/api/articles/${DRAFT}/like`, undefined, probe);
  check(draftLike.status === 404 && draftLike.json?.error === "文章不存在", "草稿不能被点赞 → 404", draftLike.json);
  const anonLike = await call(JAVA, "POST", `/api/articles/${FIX}/like`);
  check(anonLike.status === 401 && anonLike.json?.error === "登录后才能点赞", "未登录点赞 401 文案一致");

  /* ---------- 4 收藏 ---------- */
  console.log("\n## 4 收藏（INSERT IGNORE 判态 + 死锁重放）");
  const bm1 = await call(NODE, "POST", `/api/articles/${FIX}/bookmark`, undefined, probe);
  check(bm1.status === 200 && bm1.json?.bookmarked === true, "Node 收藏成功", bm1.json);
  const bm2 = await call(JAVA, "POST", `/api/articles/${FIX}/bookmark`, undefined, probe);
  check(bm2.status === 200 && bm2.json?.bookmarked === false, "Java 再点即取消收藏", bm2.json);
  const bm3 = await call(JAVA, "POST", `/api/articles/${FIX}/bookmark`, undefined, probe);
  check(bm3.json?.bookmarked === true, "再点回来", bm3.json);
  const saved = await call(JAVA, "GET", `/api/articles/${FIX}/saved`, undefined, probe);
  check(saved.json?.saved === true, "收藏态读侧认得这条跨栈写的行", saved.json);
  const raceBm = await race("POST", `/api/articles/${REP}/bookmark`, undefined, probe, 6);
  raceAlive("并发收藏", raceBm);
  const bmRows = await num("SELECT COUNT(*) FROM bookmarks WHERE user_id = ? AND article_id = ?", [probeId, repId]);
  check(bmRows <= 1, "并发后收藏关系行至多一行（uk_bm 是唯一裁决者）", String(bmRows));
  const anonBm = await call(NODE, "POST", `/api/articles/${FIX}/bookmark`);
  check(anonBm.status === 401 && anonBm.json?.error === "登录后才能收藏", "未登录收藏 401");
  const draftBm = await call(JAVA, "POST", `/api/articles/${DRAFT}/bookmark`, undefined, probe);
  check(draftBm.status === 200 && draftBm.json?.bookmarked === false,
    "草稿收藏静默回 false：文章不存在时不报错也不种下外键子行", draftBm.json);

  /* ---------- 5 评论点赞与关注 ---------- */
  console.log("\n## 5 评论点赞与关注");
  const cl1 = await call(NODE, "POST", `/api/comments/${row?.id}/like`, undefined, probe);
  check(cl1.status === 200 && cl1.json?.liked === true && cl1.json?.likes === 1, "Node 评论点赞", cl1.json);
  const cl2 = await call(JAVA, "POST", `/api/comments/${row?.id}/like`, undefined, probe);
  check(cl2.json?.liked === false && cl2.json?.likes === 0, "Java 取消同一条评论的赞", cl2.json);
  const clBad = await call(JAVA, "POST", "/api/comments/abc/like", undefined, probe);
  check(clBad.status === 400 && clBad.json?.error === "参数无效", "非数字评论 id → 参数无效", clBad.json);
  const clAnon = await call(JAVA, "POST", `/api/comments/${row?.id}/like`);
  check(clAnon.status === 401 && clAnon.json?.error === "登录后才能点赞评论", "未登录点赞评论 401");
  const raceCl = await race("POST", `/api/comments/${row?.id}/like`, undefined, probe, 6);
  raceAlive("并发评论点赞", raceCl);
  const clRows = await num("SELECT COUNT(*) FROM comment_likes WHERE comment_id = ? AND user_id = ?", [row?.id, probeId]);
  check(clRows <= 1, "评论点赞关系行至多一行（uk_cl）", String(clRows));
  const listAgain = await call(NODE, "GET", `/api/articles/${FIX}/comments`, undefined, probe);
  const shown = (listAgain.json?.comments ?? []).find((c) => c.id === row?.id);
  check(shown && Number(shown.likes) === clRows,
    "评论列表的 likes 就是关系行数（读者看到的数字与库一致）", `显示 ${shown?.likes} / 行 ${clRows}`);

  const f1 = await call(NODE, "POST", `/api/users/${writerId}/follow`, undefined, probe);
  check(f1.status === 200 && f1.json?.following === true && typeof f1.json?.followers === "number",
    "Node 关注作者", f1.json);
  check(Object.keys(f1.json ?? {}).join(",") === "ok,followers,following",
    "响应键序为 ok,followers,following：Node 先展开计数再写布尔，同名键由布尔覆盖",
    Object.keys(f1.json ?? {}));
  const f2 = await call(JAVA, "POST", `/api/users/${writerId}/follow`, undefined, probe);
  check(f2.json?.following === false && f2.json?.followers === f1.json?.followers - 1,
    "Java 再点即取关，粉丝数同步回落", f2.json);
  const f3 = await call(JAVA, "POST", `/api/users/${writerId}/follow`, undefined, probe);
  check(f3.json?.following === true && f3.json?.followers === f1.json?.followers,
    "再关注回来，计数与第一次一致（没有多算）", f3.json);
  const self = await call(JAVA, "POST", `/api/users/${probeId}/follow`, undefined, probe);
  check(self.status === 400 && self.json?.error === "不能关注自己", "自关 400 文案一致", self.json);
  const noUser = await call(JAVA, "POST", "/api/users/abc/follow", undefined, probe);
  check(noUser.status === 404 && noUser.json?.error === "用户不存在", "非法用户 id → 404", noUser.json);
  const anonF = await call(NODE, "POST", `/api/users/${writerId}/follow`);
  check(anonF.status === 401 && anonF.json?.error === "请先登录", "未登录关注 401");
  const raceF = await race("POST", `/api/users/${writerId}/follow`, undefined, probe, 6);
  raceAlive("并发关注", raceF);
  const fRows = await num("SELECT COUNT(*) FROM follows WHERE follower_id = ? AND followee_id = ?", [probeId, writerId]);
  const fStat = await num("SELECT COUNT(*) FROM follows WHERE followee_id = ?", [writerId]);
  check(fRows <= 1 && fStat >= 0, "并发后关注关系行至多一行", String(fRows));
  const told = await num(
    "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND type = 'system' AND title = '有新读者关注了你' AND id > ?",
    [writerId, mark.notice]);
  check(told >= 1, "关注成功给被关注者发了站内信（取关不发，避免打扰）", String(told));

  /* ---------- 6 举报防重 ---------- */
  console.log("\n## 6 举报（防重靠锁，表上并无唯一键）");
  const idx = await many("SHOW INDEX FROM reports");
  // 只看"唯一索引里有没有 reporter/target"——普通二级索引（fk_report_user 那种）不算防重
  const uniqueCols = idx.filter((i) => i.Non_unique === 0).map((i) => i.Column_name);
  check(!uniqueCols.some((c) => /reporter_id|target_id/.test(c)),
    "reports 表确实没有 (reporter,target) 唯一索引 → 防重只能靠事务里锁住目标行",
    [...new Set(idx.filter(i => i.Non_unique === 0).map(i => i.Key_name))].join(","));
  const rep1 = await call(NODE, "POST", `/api/articles/${REP}/report`, { reason: "闸门举报：内容不实" }, probe);
  check(rep1.status === 200 && rep1.json?.message === "举报已提交，运营会尽快核查", "Node 举报成功", rep1.json);
  const rep2 = await call(JAVA, "POST", `/api/articles/${REP}/report`, { reason: "再来一次" }, probe);
  check(rep2.status === 409 && rep2.json?.error === "该文章已有你提交的举报待处理，请耐心等待",
    "Java 认得 Node 落的那条 open 举报 → 409（跨栈判重）", rep2.json);
  const short = await call(JAVA, "POST", `/api/articles/${FIX}/report`, { reason: " 短 " }, probe);
  check(short.status === 400 && short.json?.error === "请填写举报原因（至少 2 字）",
    "原因先 trim 再判长度（两侧同序，反过来的话「 短 」会被放行）", short.json);
  const noTarget = await call(JAVA, "POST", "/api/articles/p5-not-here/report", { reason: "举报不存在" }, probe);
  check(noTarget.status === 404 && noTarget.json?.error === "文章不存在", "举报未发布/不存在的文章 → 404", noTarget.json);
  const anonRep = await call(NODE, "POST", `/api/articles/${FIX}/report`, { reason: "游客举报" });
  check(anonRep.status === 401 && anonRep.json?.error === "登录后才能举报", "未登录举报 401");
  const raceRep = await race("POST", `/api/articles/${FIX}/report`, { reason: "并发举报" }, probe, 6);
  raceAlive("并发举报", raceRep);
  const repRows = await num(
    "SELECT COUNT(*) FROM reports WHERE reporter_id = ? AND target_type = 'article' AND target_id = ? AND status = 'open'",
    [probeId, artId]);
  check(repRows === 1, "六路并发举报只落 1 行 open", String(repRows));
  const okRep = raceRep.filter((x) => x.status === 200).length;
  const dupRep = raceRep.filter((x) => x.status === 409).length;
  check(okRep === 1 && dupRep === raceRep.length - 1,
    "恰好一路 200、其余全 409（既没有 500，也没有静默多写）", hist(raceRep));
  const cRep = await call(JAVA, "POST", `/api/comments/${row?.id}/report`, { reason: "举报这条评论" }, probe);
  check(cRep.status === 200, "评论举报走同一条链路", cRep.json);
  const cRepDup = await call(NODE, "POST", `/api/comments/${row?.id}/report`, { reason: "再举报" }, probe);
  check(cRepDup.status === 409 && cRepDup.json?.error === "该评论已有你提交的举报待处理，请耐心等待",
    "评论举报的重复文案与文章举报各自独立（读者看到的提示指向自己举报的东西）", cRepDup.json);
  const cRepGhost = await call(JAVA, "POST", "/api/comments/99999999/report", { reason: "举报空气" }, probe);
  check(cRepGhost.status === 404 && cRepGhost.json?.error === "评论不存在或已被删除",
    "不存在的评论 → 404 且文案精确", cRepGhost.json);
  const badId = await call(NODE, "POST", "/api/comments/x/report", { reason: "举报空气" }, probe);
  check(badId.status === 400 && badId.json?.error === "评论不存在", "非数字评论 id 在任何 SQL 之前就被拒", badId.json);
  const mineReports = await num("SELECT COUNT(*) FROM reports WHERE reporter_id = ? AND id > ?", [probeId, mark.report]);
  check(mineReports === 3, `本环节探针共 3 条举报入队（并发那批只算 1 条）`, String(mineReports));

  /* ---------- 7 付费墙到达埋点 ---------- */
  console.log("\n## 7 付费墙埋点（去重窗口在进程内，不跨栈共享）");
  const pv0 = await num("SELECT paywall_views FROM articles WHERE id = ?", [artId]);
  const free = await call(NODE, "POST", `/api/articles/${FIX}/paywall-view`);
  check(free.status === 200 && free.json?.ok === true, "匿名可打（漏斗需要游客数据）", free.json);
  const pv1 = await num("SELECT paywall_views FROM articles WHERE id = ?", [artId]);
  check(pv1 === pv0 + 1, "第一次到达计 1", `${pv0} → ${pv1}`);
  const again = await call(NODE, "POST", `/api/articles/${FIX}/paywall-view`);
  const pv2 = await num("SELECT paywall_views FROM articles WHERE id = ?", [artId]);
  check(again.json?.deduped === true && pv2 === pv1, "同 IP 30 分钟内二次到达不计数", `库 ${pv2}`);
  const cross = await call(JAVA, "POST", `/api/articles/${FIX}/paywall-view`);
  const pv3 = await num("SELECT paywall_views FROM articles WHERE id = ?", [artId]);
  check(cross.json?.deduped !== true && pv3 === pv1 + 1,
    "换一栈就是换一进程：窗口各自记各自的 → 双轨期同一读者最多被计两次，切完即收敛（此差异已知且刻意保留）",
    `库 ${pv3}`);
  const long = await call(NODE, "POST", `/api/articles/${"p5-长".repeat(70)}/paywall-view`);
  check(long.status === 400 && long.json?.ok === false, "slug 超 200 字符直接拒，不进 SQL", long.status);
  const draftPv = await call(JAVA, "POST", `/api/articles/${DRAFT}/paywall-view`);
  const draftViews = await num("SELECT paywall_views FROM articles WHERE id = ?", [draftId]);
  check(draftPv.status === 200 && draftViews === 0,
    "草稿/免费文即使被打也不计数（SQL 里带 status='published' 与 unlock_price>0）", String(draftViews));

  /* ---------- 8 站内信读侧 ---------- */
  console.log("\n## 8 站内信");
  const n1 = await call(NODE, "GET", "/api/notifications", undefined, writer);
  const n2 = await call(JAVA, "GET", "/api/notifications", undefined, writer);
  const brief = (r) => JSON.stringify((r.json?.notifications ?? []).slice(0, 8).map((x) =>
    [x.id, x.type, x.title, x.body ?? null, x.link ?? null, x.isRead]));
  check(n1.status === 200 && n2.status === 200 && brief(n1) === brief(n2),
    "作者视角最近 8 条通知两栈逐字一致", brief(n2).slice(0, 160));
  const keys = Object.keys(n2.json?.notifications?.[0] ?? {});
  check(keys.join(",") === "id,type,title,body,link,isRead,createdAt", "通知项键序与 Node 相同", keys);
  check(Number(n1.json?.unread) === Number(n2.json?.unread), "未读数两栈一致",
    `${n1.json?.unread} vs ${n2.json?.unread}`);
  const unreadOne = (n2.json?.notifications ?? []).find((x) => x.isRead === false && x.type === "comment");
  check(!!unreadOne, "本环节产生的「文章收到新评论」在列表里且未读", unreadOne?.title);
  if (unreadOne) {
    const markOne = await call(NODE, "POST", "/api/notifications/read", { id: unreadOne.id }, writer);
    check(markOne.status === 200 && markOne.json?.ok === true && markOne.json?.affected === 1,
      "Node 标记单条已读 → affected 1", markOne.json);
    const afterJava = await call(JAVA, "GET", "/api/notifications", undefined, writer);
    const seen = (afterJava.json?.notifications ?? []).find((x) => x.id === unreadOne.id);
    check(seen?.isRead === true, "Java 立即认得这条已读（跨栈同库，无缓存）", seen?.isRead);
    check(Number(afterJava.json?.unread) === Number(n2.json?.unread) - 1,
      "未读数随之下降 1", `${n2.json?.unread} → ${afterJava.json?.unread}`);
    const other = await call(JAVA, "POST", "/api/notifications/read", { id: unreadOne.id }, probe);
    check(other.status === 200 && other.json?.affected === 0,
      "别人的一条标不动（UPDATE 带 user_id 限定，防越权改他人通知）", other.json);
  }
  const allRead = await call(JAVA, "POST", "/api/notifications/read", {}, writer);
  check(allRead.status === 200 && allRead.json?.ok === true && allRead.json?.affected === undefined,
    "不带 id 走「全部已读」分支，响应里没有 affected 键（Node 同形）", allRead.json);
  const leftUnread = await num("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0", [writerId]);
  check(leftUnread === 0, "全部已读后没有残留未读", String(leftUnread));
  const anonNotice = await call(NODE, "GET", "/api/notifications");
  check(anonNotice.status === 401 && anonNotice.json?.error === "请先登录", "未登录读通知 401");
  const badRead = await call(NODE, "POST", "/api/notifications/read", { id: "abc" }, writer);
  check(badRead.status === 200 && badRead.json?.ok === true,
    "id 非法时退回「全部已读」而不是报错（Number.isInteger 判据一致）", badRead.json);

  /* ---------- 9 账实核对 ---------- */
  console.log("\n## 9 账实核对");
  for (const [uid, name] of [[probeId, "探针"], [writerId, "作者"]]) {
    const now = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
    const led = await num(
      "SELECT IFNULL(SUM(delta),0) FROM point_ledger WHERE user_id = ? AND id > ?", [uid, mark.ledger]);
    const base = uid === probeId ? balProbe : balWriter;
    check(now - base === led, `${name}：Δ余额 = ΔΣ流水`, `Δ余额 ${now - base} / Δ流水 ${led}`);
  }
  const reasons = [...new Set((await many(
    "SELECT reason FROM point_ledger WHERE id > ? AND user_id IN (?,?)", [mark.ledger, probeId, writerId])
  ).map((r) => r.reason))];
  check(reasons.length && reasons.every((r) => ["评论互动", "文章被评论"].includes(r)),
    "本环节只产生这两类奖励流水（没有误扣别的账）", reasons);
  return ctxLocal;
}

/** 建一篇夹具文章；status 控制它是否公开可评论，price 决定它有没有付费墙（环节 7 要有）。 */
async function createArticle(authorId, slug, title, status, price = 0) {
  await conn.query(
    `INSERT INTO articles (author_id, slug, title, md_content, status, review_status, unlock_price)
     VALUES (?, ?, ?, ?, ?, 'approved', ?)`,
    [authorId, slug, title, `${title}\n\n第二行。`, status, price]
  );
  return Number((await only("SELECT id FROM articles WHERE slug = ?", [slug])).id);
}

async function cleanup(c) {
  const m = c.mark;
  // 先算奖励净额再删流水：反过来就删无可删，余额也就拨不回去了
  const sum = async (uid) => await num(
    "SELECT IFNULL(SUM(delta),0) FROM point_ledger WHERE user_id = ? AND id > ? AND reason IN ('评论互动','文章被评论')",
    [uid, m.ledger]);
  const dProbe = await sum(c.probeId);
  const dWriter = await sum(c.writerId);
  await conn.query("DELETE FROM comments WHERE article_id IN (?,?,?)", [c.artId, c.draftId, c.repId]);
  await conn.query("DELETE FROM comment_likes WHERE comment_id > ?", [m.comment]);
  await conn.query("DELETE FROM article_likes WHERE article_id IN (?,?,?)", [c.artId, c.draftId, c.repId]);
  await conn.query("DELETE FROM bookmarks WHERE user_id IN (?,?) AND article_id IN (?,?,?)",
    [c.probeId, c.writerId, c.artId, c.draftId, c.repId]);
  await conn.query("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?", [c.probeId, c.writerId]);
  await conn.query("DELETE FROM reports WHERE id > ?", [m.report]);
  await conn.query("DELETE FROM notifications WHERE id > ?", [m.notice]);
  if (c.wasUnread.length) {
    await conn.query(
      `UPDATE notifications SET is_read = 0 WHERE id IN (${c.wasUnread.map(() => "?").join(",")})`,
      c.wasUnread);
  }
  await conn.query("DELETE FROM point_ledger WHERE id > ? AND reason IN ('评论互动','文章被评论')", [m.ledger]);
  await conn.query("DELETE FROM reward_counters WHERE user_id IN (?,?) AND cnt_day = ?",
    [c.probeId, c.writerId, c.day]);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [c.balProbe, c.probeId]);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [c.balWriter, c.writerId]);
  await conn.query("DELETE FROM articles WHERE id IN (?,?,?)", [c.artId, c.draftId, c.repId]);
  const left = await num(`SELECT (SELECT COUNT(*) FROM articles WHERE slug LIKE 'p5-community-%')
    + (SELECT COUNT(*) FROM comments WHERE article_id NOT IN (SELECT id FROM articles))
    + (SELECT COUNT(*) FROM reports WHERE id > ?)
    + (SELECT COUNT(*) FROM point_ledger WHERE id > ? AND reason IN ('评论互动','文章被评论'))`,
    [m.report, m.ledger]);
  const balOk = await num("SELECT points_balance FROM users WHERE id = ?", [c.probeId]);
  const ledOk = await num("SELECT IFNULL(SUM(delta),0) FROM point_ledger WHERE user_id = ?", [c.probeId]);
  if (left !== 0) throw new Error(`清场后仍有残留 ${left} 项，请手工核对`);
  if (balOk !== c.balProbe) throw new Error(`探针余额未复原：${balOk} ≠ ${c.balProbe}`);
  return { dProbe, dWriter, ledOk };
}
