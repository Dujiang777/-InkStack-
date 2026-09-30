#!/usr/bin/env node
// 第二十一道闸门：文章表上那几列"计数器"必须与它们所总结的行集**逐列相等**。
//
// 起因是一类看不见的缺陷：`articles` 表上有四列摘要值（read_count / comment_count /
// like_count / agent_qa_count），页面、热榜排序、成就徽章、运营台漏斗都在**读**它们，
// 而其中一列（read_count）在换栈前后**从来没有任何人写过**——只有 db/schema.sql 末尾那几行
// 种子给过 12840 这样的数字。于是"阅读 12,840"是一个永远不动的展示值：
//   · 热榜式子里 read_count 那一项对真实流量毫无反应；
//   · 「总阅读破 100 / 破 1000」两枚徽章不可完成（BadgeService 就按这一列算）；
//   · 书房那张付费墙漏斗拿它当分母，而分子 paywall_views 是活的——真实流量一来，
//     转化率会算出超过 100% 这种荒数，而任何单点判据都看不出来。
// 这类东西**所有既有闸门都是绿的**：对拍比的是应答形状、契约基线比的是形状、页面判据比的是
// DOM 上有没有那个数字——"有"和"对"是两件事。所以这一道不复测形状，只复算**数**。
//
// 判据的形状（两条腿，缺一条就会退化成一堆空断言）：
//   §2–§5  自建一篇四列全 0 的夹具文章，用**真实接口**把四条写路径各驱动若干次，
//          每一步都断言 stored == 行集复算。从 0 开始是关键：种子那几篇的基线是虚构的，
//          在它们身上比"增量"才能比出东西，而增量判据在"两边都不动"时照样绿。
//   §6     删除路径同样要守恒。运营台直接删评论（连带一级回复）与举报处置删评论（只删被举报
//          那一行）是两条不同的 SQL，P8b 之前后者扣不回数——"扣回"这件事必须按实际删掉的行数，
//          两条路各自的口径不一样，判据也就得分开钉。
//   §7     源码棘轮：四列每列都必须至少有一处 `col = col + 1`；每一条 `DELETE FROM comments`
//          的调用点附近都必须配一次扣回。这一条是"如果 read_count 又变回只有种子在写，
//          机器要当场说出来"。
//   §8     全库逐列复算 + 豁免登记表（棘轮**双向**）：登记表外的任何不一致红；
//          登记表里那个名字已经守恒了也红（该摘掉却不摘，下一个读的人会以为数据还是坏的）。
//
// 口径（2026-09-30 由 dujiang 拍定，改动判据时先回来看这一段）：
//   · 一次阅读 = **登录读者每打开一次算一次**，游客不计——POST /api/history 本来就只对游客回
//     skipped。所以 read_count 与 SUM(read_history.read_times) 是同一件事的两个名字。
//   · 种子写进去的虚构数字**保留**（演示首屏要有好看的读数），代价就是 §8 那张豁免表；
//     表里逐条点名，不写成"凡是种子稿一律不查"这种会把判据掏空的规则。
//   · 复算式与那张登记表的**出处**是 `scripts/counter-exempts.mjs`（P8c 收进去的）：这一道 import
//     它们，改那一个文件等于同时改了这道闸门和 `scripts/recounters.mjs`（修数据那一条）。
//     判的与修的各抄一份，最后会走成两边口径不一样——那时"修完了"和"判绿了"不再是同一件事。
//
//   node scripts/counter-check.mjs              跑完清场（夹具文章、评论、点赞、足迹、
//                                               问答流水、站内信、审计、奖励流水与计数全还原）
//   node scripts/counter-check.mjs --keep       保留现场
//
// 前提：
//   ① 一个 Java 实例（直连即可，不需要 Next 代理——这一道不比经 rewrite 的保真度）：
//        COUNTER_BASE=http://localhost:3101 node scripts/counter-check.mjs
//   ② 想跑 §5（agent_qa_count）必须让那一台的 agent 通道落在 **agentscope** 档，也就是把它指到
//      本闸门的夹具上游（默认 127.0.0.1:4601，闸门自己会起）：
//        mvn ... spring-boot:run -Dspring-boot.run.arguments="--inkstack.agent.service-url=http://127.0.0.1:4601"
//      不是这一档时 §5 整段记 SKIP 而不是发问：**live 档会真调大模型、真扣墨，demo 档压根不落流水**，
//      两种都问不出东西，宁可不测。
//   ③ DATABASE_URL 指向克隆库 inkstack_j：会真建真删文章、真写流水。脚本先断言库名，
//      打在主库（inkstack）上就直接拒绝起跑。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
// 复算式与豁免登记表**只有这一份**：判的那一条（闸门 21）和修的那一条（recounters）共用，
// 抄两份迟早走成"修的人按 A 口径、判的人按 B 口径"。
import { COLUMNS, EXEMPT, measureDrift, exemptKey, isExempt } from "./counter-exempts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const BASE = process.env.COUNTER_BASE || env.PARITY_JAVA || "http://localhost:3101";
const FIXTURE_PORT = Number(process.env.COUNTER_FIXTURE_PORT || 4601);
const KEEP = process.argv.includes("--keep");
const TAG = "P8b 守恒夹具";

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
/** SKIP 不是 PASS：没有宾语的判据必须让报表上看得见它没跑。 */
function skipped(label, why) {
  skip++;
  console.log(`SKIP  ${label}  — ${why}`);
}

const mysql = createRequire(import.meta.url)("mysql2/promise");
const conn = await mysql.createConnection(env.DATABASE_URL);
const only = async (sql, params = []) => (await conn.query(sql, params))[0][0] ?? null;
const num = async (sql, params = []) => {
  const row = await only(sql, params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? 0 : Number(v);
};

async function call(method, url, body, cookie) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + url, { method, headers: h, body: payload });
  } catch (down) {
    return { status: 0, json: null, text: `${BASE} 连不上：${down?.message ?? down}`, backend: "" };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* NDJSON 流走这里 */ }
  return { status: res.status, json, text, backend: res.headers.get("x-backend") ?? "" };
}
async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error(`${email} 登录失败 ${res.status}`);
  return cookie;
}

/* ==================== 上游夹具（只为把 agent 通道钉在 agentscope 档） ==================== */

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", engine: "counter-check-fixture" }));
  }
  if (url === "/agent/ask") {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const line of [
      JSON.stringify({ type: "delta", text: "夹具" }),
      JSON.stringify({ type: "delta", text: "分身" }),
      JSON.stringify({ type: "cite", citation: "《夹具·守恒》" }),
    ]) {
      res.write(line + "\n");
    }
    return res.end();
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("夹具没有这条路径");
});
const listen = () => new Promise((resolve, reject) => {
  server.once("error", (e) => {
    // 端口上已经有东西（比如闸门 14 那对实例指的夹具还活着）：照样能跑，
    // 这一道只问"流水有没有落上、计数有没有跟"，不问上游答了什么。
    if (e.code === "EADDRINUSE") { console.log(`    （${FIXTURE_PORT} 已被占用，按现场上游继续）`); return resolve(); }
    reject(e);
  });
  server.listen(FIXTURE_PORT, "127.0.0.1", resolve);
});
const closeOnce = () => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.once("close", resolve);
  server.close();
});

/* ==================== 现场与清场 ==================== */

const state = {};
async function cleanup() {
  if (!state.artId) return "（没建夹具）";
  const a = [state.artId, state.draftId];
  const ph = a.map(() => "?").join(",");
  // 计数留档只为了最后那句"清掉多少"，删的顺序要按外键来（comments / likes 有 RESTRICT）
  const notes = [];
  const countOf = async (table, where, params) => {
    const n = await num(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
    if (n) notes.push(`${table} ${n} 行`);
    return n;
  };
  await countOf("comments", `article_id IN (${ph})`, a);
  await conn.query(`DELETE FROM comments WHERE article_id IN (${ph})`, a);
  await countOf("article_likes", `article_id IN (${ph})`, a);
  await conn.query(`DELETE FROM article_likes WHERE article_id IN (${ph})`, a);
  await countOf("read_history", `article_id IN (${ph})`, a);
  await conn.query(`DELETE FROM read_history WHERE article_id IN (${ph})`, a);
  await countOf("agent_qa", "id > ?", [state.mark.qa]);
  await conn.query("DELETE FROM agent_qa WHERE id > ?", [state.mark.qa]);
  await countOf("reports", "id > ?", [state.mark.report]);
  await conn.query("DELETE FROM reports WHERE id > ?", [state.mark.report]);
  await countOf("notifications", "id > ?", [state.mark.notice]);
  await conn.query("DELETE FROM notifications WHERE id > ?", [state.mark.notice]);
  await countOf("admin_actions", "id > ?", [state.mark.action]);
  await conn.query("DELETE FROM admin_actions WHERE id > ?", [state.mark.action]);
  await countOf("point_ledger", "id > ?", [state.mark.ledger]);
  await conn.query("DELETE FROM point_ledger WHERE id > ?", [state.mark.ledger]);
  // 奖励日上限按天存，删掉本轮那一条才能让明天与今天互不影响
  await conn.query("DELETE FROM reward_counters WHERE user_id IN (?,?,?) AND cnt_day = ?",
    [state.probeId, state.writerId, state.adminId, state.day]);
  for (const [uid, bal] of [[state.probeId, state.balProbe], [state.writerId, state.balWriter],
    [state.adminId, state.balAdmin]]) {
    await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [bal, uid]);
  }
  await conn.query(`DELETE FROM articles WHERE id IN (${ph})`, a);
  // 残留复核用**内插的数值 id**（id 来自库，且这里强制是有限整数），
  // 因为这条一句 SQL 里 IN (?,?) 出现了四次，参数表要重复四遍反而更容易写错
  const ids = a.map(Number);
  if (!ids.every(Number.isFinite)) throw new Error(`夹具 id 不是数字：${JSON.stringify(ids)}`);
  const inIds = ids.join(",");
  const left = await num(`SELECT (SELECT COUNT(*) FROM articles WHERE slug LIKE 'p8b-counter-%')
    + (SELECT COUNT(*) FROM comments WHERE article_id IN (${inIds}))
    + (SELECT COUNT(*) FROM article_likes WHERE article_id IN (${inIds}))
    + (SELECT COUNT(*) FROM read_history WHERE article_id IN (${inIds}))
    + (SELECT COUNT(*) FROM agent_qa WHERE id > ${Number(state.mark.qa)})
    + (SELECT COUNT(*) FROM point_ledger WHERE id > ${Number(state.mark.ledger)})`);
  if (left !== 0) throw new Error(`清场后仍有残留 ${left} 项，请手工核对`);
  return `删掉 ${notes.join("、")}，三台账号余额复原（探针 ${state.balProbe}、作者 ${state.balWriter}、运营 ${state.balAdmin}）`;
}

try {
  await listen();
  await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  await closeOnce();
  if (state.artId) {
    if (KEEP) {
      console.log("\n--keep：现场未清理");
    } else {
      try {
        console.log(`\n已清场：${await cleanup()}`);
      } catch (e) {
        console.error("清场失败，克隆库可能残留测试数据：", e.message);
        fail++;
      }
    }
  }
  await conn.end().catch(() => {});
}
console.log(`\n合计 ${pass + fail + skip} 项，失败 ${fail} 项，SKIP ${skip} 项`);
process.exit(fail ? 1 : 0);

/* ==================== 用例主体 ==================== */

async function suit() {
  /* ---------- 0 前置自检 ---------- */
  console.log(`\n## 0 起跑前先把"我在哪、我在打谁"说清楚`);
  const db = (await only("SELECT DATABASE() AS d"))?.d;
  check(db && db !== "inkstack", "数据库必须是克隆库，不能是主库",
    () => `SELECT DATABASE() = ${db}`);
  const probe0 = await call("GET", "/api/articles?limit=1");
  check(probe0.status === 200 && probe0.backend === "inkstack-java",
    `实例活着且由 Java 应答`, () => `${BASE} → ${probe0.status}/${probe0.backend || "无 x-backend"}`);
  const probeId = await num("SELECT id FROM users WHERE email = ?", [env.INK_PROBE_EMAIL]);
  const writerId = await num("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]);
  const adminId = await num("SELECT id FROM users WHERE email = ?", [env.INK_TEST_EMAIL]);
  check(probeId && writerId && adminId, "三个账号都在（探针 / 作者 / 运营）",
    () => `探针=${probeId} 作者=${writerId} 运营=${adminId}`);

  const probe = await login(env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD);
  const writer = await login(env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  const admin = await login(env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD);
  const balProbe = await num("SELECT points_balance FROM users WHERE id = ?", [probeId]);
  const balWriter = await num("SELECT points_balance FROM users WHERE id = ?", [writerId]);
  const balAdmin = await num("SELECT points_balance FROM users WHERE id = ?", [adminId]);
  // 问答一次 5 滴，作者余额太薄就先垫（垫的不落流水，收尾按快照收回）
  if (balWriter < 40) {
    await conn.query("UPDATE users SET points_balance = points_balance + 200 WHERE id = ?", [writerId]);
  }
  const run = Math.floor(Math.random() * 1e6);
  const day = (await only("SELECT DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS d"))?.d;
  const mark = {
    ledger: await num("SELECT IFNULL(MAX(id),0) FROM point_ledger"),
    notice: await num("SELECT IFNULL(MAX(id),0) FROM notifications"),
    action: await num("SELECT IFNULL(MAX(id),0) FROM admin_actions"),
    report: await num("SELECT IFNULL(MAX(id),0) FROM reports"),
    // 问答流水要按 id 区间删：不归属任何文章的那几条（草稿 slug、不带 article）没有 article_id，
    // 只按 article_id 删就会把它们留在库里——上一轮就是这么漏的，下一轮立刻把"同题两条"报成红
    qa: await num("SELECT IFNULL(MAX(id),0) FROM agent_qa"),
  };

  /* ---------- 1 夹具：四列全 0 的两篇文章 ---------- */
  console.log("\n## 1 夹具从零起（基线是虚构的种子稿比不出增量，只有 0 起点的能比）");
  const slug = (k) => `p8b-counter-${k}-${run}`;
  const make = async (k, status) => {
    await conn.query(
      `INSERT INTO articles (author_id, slug, title, md_content, summary, tags, status, review_status)
       VALUES (?,?,?,?,?,?,?, 'approved')`,
      [writerId, slug(k), `${TAG}·${k}`, `${TAG} 正文。\n\n第二段。`, "摘要", '["闸门"]', status]
    );
    return Number((await only("SELECT id FROM articles WHERE slug = ?", [slug(k)])).id);
  };
  const artId = await make("pub", "published");
  const draftId = await make("draft", "draft");
  Object.assign(state, { artId, draftId, probeId, writerId, adminId, day, mark,
    balProbe, balWriter, balAdmin });
  const stored = async (col, id) => num(`SELECT ${col} FROM articles WHERE id = ?`, [id]);
  const real = async (spec, id) => num(...spec.real(id));
  const snapshot = async (id) => {
    const out = {};
    for (const s of COLUMNS) out[s.col] = { stored: await stored(s.col, id), real: await real(s, id) };
    return out;
  };
  /** 这一道的心脏：某一列的 stored 必须等于它对行集复算出来的值。 */
  const conserved = async (label, id, spec) => {
    const s = await stored(spec.col, id);
    const r = await real(spec, id);
    return check(s === r, `${label}：${spec.col} == 复算值`,
      () => `stored=${s} real=${r}（${spec.why}）`);
  };
  const start = await snapshot(artId);
  check(COLUMNS.every((s) => start[s.col].stored === 0 && start[s.col].real === 0),
    "夹具两篇的四列起点都是 0（stored 与行集都是）", () => JSON.stringify(start));
  check((await stored("comment_count", draftId)) === 0, "草稿夹具也是干净基线（它全程都不该被写）",
    String(await stored("comment_count", draftId)));

  /* ---------- 2 read_count：四条腿里唯一"从前根本没人写"的那一条 ---------- */
  console.log("\n## 2 read_count：登录读者每打开一次 +1，且与 SUM(read_history.read_times) 同涨");
  const READ = COLUMNS[0];
  await call("POST", "/api/history", { slug: slug("pub") }, probe);
  await conserved("① 探针第一次读", artId, READ);
  check(await stored("read_count", artId) === 1, "第一次读之后 stored 是 1（这一列从前永远是 0 或种子值）",
    String(await stored("read_count", artId)));
  await call("POST", "/api/history", { slug: slug("pub") }, probe);
  await conserved("② 同一人重读", artId, READ);
  await call("POST", "/api/history", { slug: slug("pub") }, writer);
  await conserved("③ 换一个人读", artId, READ);
  await call("POST", "/api/history", { slug: slug("pub") }, probe);
  const rowsH = await num("SELECT COUNT(*) FROM read_history WHERE article_id = ?", [artId]);
  const read4 = await stored("read_count", artId);
  check(read4 === 4 && rowsH === 2,
    "④ 口径钉死：计数按**次**涨、足迹按**人**去重（4 次读落在 2 个人、2 行足迹上）",
    () => `read_count=${read4} 足迹行=${rowsH} SUM(read_times)=4`);
  const guestRead = await call("POST", "/api/history", { slug: slug("pub") });
  const gBal = await stored("read_count", artId);
  check(guestRead.status === 200 && guestRead.json?.skipped === true && gBal === 4,
    "⑤ 游客读：接口回 skipped 而不是 401，计数与足迹都不动（口径：游客不计——这是决定，不是漏写）",
    () => `status=${guestRead.status}/${JSON.stringify(guestRead.json)} stored=${gBal}`);
  await call("POST", "/api/history", { slug: slug("draft") }, probe);
  const draftReadStored = await stored("read_count", draftId);
  const draftReadRows = await num("SELECT COUNT(*) FROM read_history WHERE article_id = ?", [draftId]);
  check(draftReadStored === 0 && draftReadRows === 0,
    "⑥ 读草稿：计数与足迹都不动（bump 与 recordRead 的 status='published' 条件逐字同式）",
    () => `草稿 stored=${draftReadStored} 足迹行=${draftReadRows}`);
  const ghost = await call("POST", "/api/history", { slug: "p8b-counter-根本没有这篇" }, probe);
  const afterGhost = await stored("read_count", artId);
  check(ghost.status === 200 && afterGhost === 4,
    "⑦ slug 不存在：埋点静默、不动任何计数，也不许把读者的页面挡住（两笔写都不落）",
    () => `status=${ghost.status} stored=${afterGhost}`);

  /* ---------- 3 comment_count ---------- */
  console.log("\n## 3 comment_count：楼中楼也算一条，游客评论也算");
  const CMT = COLUMNS[1];
  const post = (body, cookie) => call("POST", `/api/articles/${slug("pub")}/comments`, body, cookie);
  const root1 = await post({ content: "守恒主楼一" }, probe);
  await conserved("① 探针发主楼", artId, CMT);
  const rootId = root1.json?.comment?.id;
  await post({ content: "回复一", parentId: rootId }, writer);
  await conserved("② 作者回一条（回复的 article_id 也归这篇）", artId, CMT);
  await post({ content: "守恒主楼二" }, writer);
  await conserved("③ 作者再发一条主楼", artId, CMT);
  await post({ content: "游客沙发", nickname: "过路人" });
  await conserved("④ 游客评论也进计数", artId, CMT);
  check((await stored("comment_count", artId)) === 4, "四条之后 stored 是 4",
    String(await stored("comment_count", artId)));
  const onDraft = await call("POST", `/api/articles/${slug("draft")}/comments`, { content: "草稿下的评论" }, probe);
  const draftCmt = await stored("comment_count", draftId);
  check(onDraft.status === 400 && draftCmt === 0,
    "⑤ 对草稿发评论：400 且计数不动（适用条件与 INSERT 的 WHERE 同式，才会一起不涨）",
    () => `status=${onDraft.status}/${onDraft.json?.error} stored=${draftCmt}`);

  /* ---------- 4 like_count ---------- */
  console.log("\n## 4 like_count：一人一行，取消即减");
  const LIKE = COLUMNS[2];
  await call("POST", `/api/articles/${slug("pub")}/like`, undefined, probe);
  await conserved("① 探针点赞", artId, LIKE);
  await call("POST", `/api/articles/${slug("pub")}/like`, undefined, probe);
  await conserved("② 再点一次是取消", artId, LIKE);
  check((await stored("like_count", artId)) === 0, "取消之后 stored 归 0（不是负数、也不是停在 1）",
    String(await stored("like_count", artId)));
  await call("POST", `/api/articles/${slug("pub")}/like`, undefined, probe);
  await call("POST", `/api/articles/${slug("pub")}/like`, undefined, writer);
  await conserved("③ 恢复 + 作者也赞", artId, LIKE);
  const draftLike = await call("POST", `/api/articles/${slug("draft")}/like`, undefined, probe);
  const draftLikeStored = await stored("like_count", draftId);
  const draftLikeRows = await num("SELECT COUNT(*) FROM article_likes WHERE article_id = ?", [draftId]);
  check(draftLikeStored === 0 && draftLikeRows === 0,
    "④ 草稿点赞：一行不落、计数不动",
    () => `status=${draftLike.status} stored=${draftLikeStored} 行=${draftLikeRows}`);

  /* ---------- 5 agent_qa_count ---------- */
  console.log("\n## 5 agent_qa_count：问答归属与计数（只有 agentscope 档可测）");
  const QA = COLUMNS[3];
  const mode = (await call("GET", "/api/agent/status"))?.json?.mode;
  if (mode === "agentscope") {
    const ask = (body) => call("POST", "/api/agent/ask", body, writer);
    const a1 = await ask({ question: "守恒问答一", article: slug("pub") });
    await conserved("① 带 article 的提问", artId, QA);
    await ask({ question: "守恒问答二", article: slug("pub") });
    await conserved("② 第二次提问", artId, QA);
    await ask({ question: "守恒问答三", article: slug("draft") });
    const draftQa = await stored("agent_qa_count", draftId);
    const draftQaRows = await num("SELECT COUNT(*) FROM agent_qa WHERE article_id = ?", [draftId]);
    const orphanQa = await num("SELECT COUNT(*) FROM agent_qa WHERE question = ? AND id > ?",
      ["守恒问答三", mark.qa]);
    check(draftQa === 0 && draftQaRows === 0 && orphanQa === 1,
      "③ 指向草稿的提问：流水照记但不归属、草稿计数不动",
      () => `草稿 stored=${draftQa} 归属行=${draftQaRows} 流水=${orphanQa}`);
    await ask({ question: "守恒问答四" });
    await conserved("④ 不带 article（全局浮窗形状）：流水不落在这篇名下、夹具计数停在原地", artId, QA);
    check(a1.status === 200, "问答应答仍是 200（这些判据都在流之后成立）", String(a1.status));
  } else {
    skipped("①–④ agent_qa_count 的四条写路径判据",
      `该实例的 /api/agent/status 是 ${mode ?? "未知"}：live 档会真调大模型真扣墨，demo 档一条流水都不落，两种都问不出东西`);
  }

  /* ---------- 6 删除路径 ---------- */
  console.log("\n## 6 两条删除路径都要守恒（它们的口径本来就不一样）");
  const rootRow = await only("SELECT id FROM comments WHERE article_id = ? AND content = ? LIMIT 1",
    [artId, "守恒主楼一"]);
  const replies = await num("SELECT COUNT(*) FROM comments WHERE article_id = ? AND parent_id = ?",
    [artId, rootRow?.id]);
  const before6 = await stored("comment_count", artId);
  const del = await call("POST", "/api/admin/comments", { commentId: rootRow?.id, action: "delete" }, admin);
  const after6 = await stored("comment_count", artId);
  check(del.status === 200 && del.json?.removed === replies + 1,
    "① 运营台删主楼连带一级回复，removed 报的是真实行数",
    () => `status=${del.status} removed=${del.json?.removed ?? JSON.stringify(del.json)} 期望=${replies + 1}`);
  check(after6 === before6 - (replies + 1),
    "② 直接删这条路扣回 = 实际删掉的行数（主楼 + 它的回复）",
    () => `${before6} → ${after6}，删了 ${replies + 1} 行`);
  await conserved("③ 删完仍然守恒", artId, CMT);

  const otherRow = await only("SELECT id FROM comments WHERE article_id = ? AND content = ? LIMIT 1",
    [artId, "游客沙发"]);
  const rep = await call("POST", `/api/comments/${otherRow?.id}/report`, { reason: "守恒闸门举报" }, probe);
  const repRow = await only("SELECT id FROM reports WHERE target_type = 'comment' AND target_id = ? ORDER BY id DESC LIMIT 1",
    [otherRow?.id]);
  const before7 = await stored("comment_count", artId);
  const handled = await call("POST", "/api/admin/reports", { reportId: repRow?.id, handle: "delete_content" }, admin);
  const after7 = await stored("comment_count", artId);
  check(rep.status === 200 && handled.status === 200, "④ 举报与处置两步都成功",
    () => `举报=${rep.status} 处置=${handled.status}`);
  check(after7 === before7 - 1,
    "⑤ 举报处置只删被举报那一行，所以扣 1（它不连带回复，扣数也就不能按楼算）",
    () => `${before7} → ${after7}`);
  await conserved("⑥ 举报删评论这条路也守恒（P8b-C 修的正是这里：从前一行都没扣）", artId, CMT);
  const leftReplies = await num("SELECT COUNT(*) FROM comments WHERE parent_id = ?", [otherRow?.id]);
  const readNow = await stored("read_count", artId);
  const likeNow = await stored("like_count", artId);
  check(readNow === 4 && likeNow === 2 && leftReplies === 0,
    "⑦ 两次删除没有误伤别的列（read/like 各自停在原位）",
    () => `read=${readNow} like=${likeNow} 孤回复=${leftReplies}`);
  // 穿底判据：先把 stored 压到比待删行数小（种子稿的真实形状就是这样），删完必须归 0 而不是负数
  await conn.query("UPDATE articles SET comment_count = 0 WHERE id = ?", [artId]);
  const restRows = await only("SELECT id FROM comments WHERE article_id = ? LIMIT 1", [artId]);
  const restCount = await num("SELECT COUNT(*) FROM comments WHERE article_id = ?", [artId]);
  const del8 = await call("POST", "/api/admin/comments", { commentId: restRows?.id, action: "delete" }, admin);
  const clamped = await stored("comment_count", artId);
  const clampedReal = await num("SELECT COUNT(*) FROM comments WHERE article_id = ?", [artId]);
  check(restCount >= 1 && clamped === 0 && clamped === clampedReal,
    "⑧ 扣回不许穿底：stored 比行数小时删掉最后一条，结果是 0 而不是负数（GREATEST 那一条）",
    () => `删前 stored=0 行=${restCount} → 删后 stored=${clamped} 行=${clampedReal} · 应答=${del8.status}/${del8.json?.removed ?? del8.text.slice(0, 60)}`);

  /* ---------- 7 源码棘轮 ---------- */
  console.log("\n## 7 源码棘轮：这四列必须**有人写**，删评论必须**有人扣**");
  const javaRoot = path.join(root, "server", "src", "main", "java");
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".java")) out.push(p);
    }
    return out;
  };
  const javaFiles = walk(javaRoot);
  // 读源码判据之前先把注释剥掉：注释里写一句 `read_count = read_count + 1` 不该算"这一列有人写"，
  // 而注释里引用坏形状（下面 CAST 那条一开始就是被我自己写的文档绊红的）也不该算红。
  // 剥的时候**行数不变**（块注释换成等量空行），这样报出来的 file:line 还指得准。
  const codeOf = (f) => fs.readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split(/\r?\n/).length - 1))
    .split(/\r?\n/).map((l) => (/^\s*(\/\/|\*)/.test(l) ? "" : l)).join("\n");
  const sources = javaFiles.map((f) => [f, codeOf(f)]);
  const bumpOf = (col) => sources.filter(([, src]) =>
    new RegExp(`${col}\\s*=\\s*${col}\\s*\\+\\s*1`).test(src)).length;
  for (const s of COLUMNS) {
    check(bumpOf(s.col) >= 1,
      `${s.col} 在 Java 里至少有一处 +1（一列没人写，读它的页面与徽章就会安静地冻住）`,
      () => `命中文件 ${bumpOf(s.col)} 个 · 这一列从前谁都没写`);
  }
  // 每一条"删评论"的 SQL，其调用点附近必须有一次扣回
  const deleteMappers = [];
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/@Delete\("([^"]*DELETE FROM comments[^"]*)"\)[\s\S]{0,80}?int (\w+)\(/g)) {
      deleteMappers.push({ method: m[2], sql: m[1], file: f });
    }
  }
  const orphanCalls = [];
  for (const d of deleteMappers) {
    for (const [f, src] of sources) {
      if (f === d.file) continue;
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!new RegExp(`\\.${d.method}\\(`).test(line)) return;
        const around = lines.slice(Math.max(0, i - 12), i + 12).join("\n");
        if (!/reclaimCommentCount/.test(around)) orphanCalls.push(`${path.relative(root, f)}:${i + 1} → ${d.method}()`);
      });
    }
  }
  check(deleteMappers.length >= 2 && orphanCalls.length === 0,
    "每一条 DELETE FROM comments 的调用点都在附近扣回了 comment_count（按实际删除的行数）",
    () => `删除方法 ${deleteMappers.map((d) => d.method).join("/")} 个，未配扣回的调用点：${orphanCalls.join("; ") || "无"}`);
  // 无符号计数列的"兜底减法"是假兜底：MySQL 先按无符号算 `col - 1`，下溢当场抛错，GREATEST 根本没被求值。
  // 这条判据抓的就是那个形状——列名直接跟在 `GREATEST(0,` 后面的写法一律红。
  const bareSub = [];
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/GREATEST\(\s*0\s*,\s*([A-Za-z_]\w*)\s*-/g)) {
      if (COLUMNS.some((c) => c.col === m[1])) bareSub.push(`${path.relative(root, f)} → ${m[0]}`);
    }
  }
  check(bareSub.length === 0,
    "无符号计数列的每一次减法都先 CAST 成 SIGNED（GREATEST 钳不住无符号下溢，只会把整条请求抛成 500）",
    () => bareSub.join(" ; ") || "两处扣数（评论 / 点赞）都合规");
  // 事务形状：两笔写要么在一个 @Transactional 的 bean 里，要么在同一个 tx.execute 里
  const recorder = codeOf(path.join(javaRoot, "com/inkstack/study/ArticleReadRecorder.java"));
  check(/@Transactional/.test(recorder) && /bumpReadCount/.test(recorder) && /recordRead/.test(recorder),
    "足迹行与 read_count 在同一个 @Transactional bean 里（同类自调用不经代理就等于没加事务）");
  const history = codeOf(path.join(javaRoot, "com/inkstack/study/HistoryController.java"));
  check(!/db\.recordRead\(/.test(history) && /reads\.record\(/.test(history),
    "HistoryController 不再自己调 recordRead：绕开 recorder 就等于绕开事务，两笔写会分家");
  const community = codeOf(path.join(javaRoot, "com/inkstack/community/CommunityService.java"));
  check(/tx\.execute\([\s\S]{0,400}addComment\(row\)[\s\S]{0,200}bumpCommentCount/.test(community),
    "评论 INSERT 与 comment_count +1 在同一个 tx.execute 里（P8b-B 之前它们是两句裸调用）");

  /* ---------- 8 全库复算 + 豁免登记表（双向棘轮） ---------- */
  console.log("\n## 8 全库逐列复算：登记表外的新不一致红，登记表里已归零的也红");
  // 复算这件事交给 counter-exempts 里那一份 measureDrift：对齐脚本修的就是它量出来的东西，
  // 两边各写一遍循环的话，"修完了"和"判绿了"会不是同一件事。
  const { articles: total, drift } = await measureDrift(conn);
  const fresh = drift.filter((d) => !isExempt(d.slug, d.col));
  check(fresh.length === 0,
    `登记表之外没有任何不一致（现存漂移 ${drift.length} 项，全部来自登记过的种子/历史数据）`,
    () => fresh.slice(0, 8).map((d) => `${d.slug}.${d.col}：stored=${d.stored} real=${d.real}`).join(" ; ") || `0 项`);
  const driftKeys = new Set(drift.map((d) => exemptKey(d.slug, d.col)));
  const stale = EXEMPT.filter((e) => !driftKeys.has(exemptKey(e[0], e[1])));
  check(stale.length === 0,
    "登记表里每一条**仍然**不一致（已经归零的却不摘，下一个人会以为数据还是坏的）",
    () => stale.slice(0, 8).map((e) => `${e[0]}.${e[1]}`).join(" ; ") || `0 条`);
  const cleanArticles = total - new Set(drift.map((d) => d.slug)).size;
  check(drift.length > 0 && cleanArticles > 0,
    "上面两条的宾语两头都非空：既有登记在册的漂移、也有四列全对得上的文章（缺任一头都是空断言）",
    () => `文章 ${total} 篇 · 全对的 ${cleanArticles} 篇 · 漂移条目 ${drift.length} · 豁免表 ${EXEMPT.length} 条`);
}
