#!/usr/bin/env node
// P6 AI 面闸门：POST /api/ai/write 的计费链路 + GET /api/agent/status 的三档模式。
//
// 这一道的核心不是「生成的文字好不好」，而是**钱只在真实产出那一刻动一次**：
//   · 只读探针 peekBalance 先拦（余额不够就不该去白耗上游 token），它不加锁、不算计费；
//   · 上游确认给出非空文本之后才 spendPoints（FOR UPDATE 原子扣 + 同事务流水）；
//   · 上游坏了 / 超时 / 非 2xx / text 是空白 → 落模板兜底，一个墨点都不扣。
// 原实现走的是「先扣后生成、失败再退分」：退分本身一失败就永久丢墨，模板兜底也照扣，
// 文案还谎报「已退回」。所以本闸门把「兜底必不扣墨」与「探针拦住就不该问上游」钉成硬断言。
//
// 另一条只有 AI 面才有的红线：**四段演示模板必须逐字节一致**。它是 Node 侧的字符串常量，
// Java 重抄一遍，少一个前导换行肉眼看不出来——而这段文字直接给读者看。
//
//   node scripts/ai-check.mjs            跑完把余额与流水复原
//   node scripts/ai-check.mjs --keep     保留现场
//
// 前提：
//   ① 常规两栈（Node 3200 / Java 3101）**不带** AGENT_SERVICE_URL → status=demo、模板兜底；
//   ② 另起一对「接了上游」的实例，AGENT_SERVICE_URL 指向闸门自己的夹具（127.0.0.1:4601）：
//        MSYS_NO_PATHCONV=1 NEXT_DIST_DIR=.next-aitest \
//          AGENT_SERVICE_URL=http://127.0.0.1:4601 node node_modules/next/dist/bin/next dev -p 3296
//        cd server && JAVA_HOME=<jdk17> mvn -o -s settings.xml spring-boot:run \
//          -Dspring-boot.run.arguments="--server.port=3196 --inkstack.agent.service-url=http://127.0.0.1:4601"
//   没有 ② 就跑不到「上游真产出 → 真扣墨」那一档，而那正是这条链路唯一会动钱的地方。
//   ③ DATABASE_URL 指向克隆库 inkstack_j：会真扣真写流水，跑完按快照复原。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";
const ANODE = process.env.AI_NODE || "http://localhost:3296";
const AJAVA = process.env.AI_JAVA || "http://localhost:3196";
const KEEP = process.argv.includes("--keep");
const FIXTURE_PORT = Number(process.env.AI_FIXTURE_PORT || 4601);
const MODES = ["continue", "polish", "title", "topic"];
const LABELS = { continue: "续写", polish: "润色", title: "起标题", topic: "推荐选题" };
const PRICES = { continue: 15, polish: 10, title: 5, topic: 5 };

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
const num = async (sql, params = []) => {
  const row = await only(sql, params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? 0 : Number(v);
};

async function call(base, method, url, body, cookie) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(base + url, { method, headers: h, body: payload });
  } catch (down) {
    return { status: 0, json: null, text: `${base} 连不上：${down?.message ?? down}`, keys: [] };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return {
    status: res.status, json, text,
    keys: json && typeof json === "object" ? Object.keys(json) : [],
    backend: res.headers.get("x-backend") ?? "",
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
const write = (base, body, cookie) => call(base, "POST", "/api/ai/write", body, cookie);
/** 扣费成功的形状：200、没有 fallback 键、pointsNote 写着已扣。 */
const paid = (r) => r.status === 200 && r.json?.fallback === undefined
  && typeof r.json?.pointsNote === "string" && r.json.pointsNote.startsWith("已扣 ");

/* ==================== 上游夹具 ==================== */

const upstreamHits = [];
let upstreamMode = "ok"; // ok | blank | error | garbage
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, agentscope: true, live: true }));
    return;
  }
  if (req.method === "POST" && url === "/ai/write") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = { unparsable: raw.slice(0, 40) }; }
      upstreamHits.push(parsed);
      if (upstreamMode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "夹具模拟上游挂了" }));
        return;
      }
      if (upstreamMode === "garbage") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("这一坨不是 JSON");
        return;
      }
      const blank = upstreamMode === "blank";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        text: blank ? "   \n\t "
          : `【夹具生成·${parsed?.mode ?? "?"}】依据草稿：${String(parsed?.draft ?? "").slice(0, 40)}`,
      }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("夹具没有这条路径");
});
const listen = () => new Promise((resolve, reject) => {
  server.once("error", reject);
  if (server.listening) resolve(); else server.listen(FIXTURE_PORT, "127.0.0.1", resolve);
});
const closeOnce = () => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.once("close", resolve);
  server.close();
});

/* ==================== 现场与清场 ==================== */

const state = {};
async function cleanup() {
  if (!state.uid) return "（没碰到账号）";
  const rows = await num("SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND id > ?",
    [state.uid, state.mark]);
  await conn.query("DELETE FROM point_ledger WHERE user_id = ? AND id > ?", [state.uid, state.mark]);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [state.balance, state.uid]);
  return `余额复原 ${state.balance}、删掉本次 ${rows} 条流水`;
}

try {
  await listen();
  await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  await closeOnce();
  if (Object.keys(state).length) {
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
console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

/* ==================== 用例主体 ==================== */

async function suit() {
  const uid = await num("SELECT id FROM users WHERE email = ?", [env.INK_WRITER_EMAIL]);
  if (!uid) throw new Error("缺少 INK_WRITER_EMAIL 账号");
  // 快照在任何扣费之前取，且放进模块级 state：中途抛错也要能复原（上一批真踩过）
  const snapshot = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  const mark = await num("SELECT IFNULL(MAX(id),0) FROM point_ledger WHERE user_id = ?", [uid]);
  Object.assign(state, { uid, balance: snapshot, mark });
  // 垫本：这一道要真扣六百来点，账号穷就跑不动。而"穷"是常事——§4 会把余额强设成 3，
  // 进程被杀（本机会话被清理踩过）时连 finally 都不走，账号就永久停在 3。
  // 所以闸门自己垫一笔够烧的，跑完由 cleanup 按 snapshot 原值收回：不假设上一批怎么退场。
  const balance = snapshot < 120 ? snapshot + 900 : snapshot;
  if (balance !== snapshot) {
    await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [balance, uid]);
    console.log(`    （账号只有 ${snapshot} 点，先垫到 ${balance} 再跑，收尾照旧收回）`);
  }
  for (const [label, base] of [["Node", ANODE], ["Java", AJAVA]]) {
    const up = await call(base, "GET", "/api/articles?limit=1");
    if (up.status !== 200) {
      throw new Error(`未检测到「接了上游夹具」的 ${label} 实例 ${base}（见本文件头部 ② 的启动命令）`);
    }
  }
  const writer = await login(NODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  const writerA = await login(ANODE, env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  /** 全场唯一的计费判据：扣了几次钱就必须有几条流水、总额必须等于档位价之和。 */
  let charged = 0;
  let chargedSum = 0;
  /** §3 抓下来的四段模板文本，§5 用它断言「坏态兜底给的就是同一份模板」。 */
  const demoText = {};
  const ledgerRows = () => num(
    "SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND id > ?", [uid, mark]);

  /* ---------- 1 三档模式 ---------- */
  console.log("\n## 1 GET /api/agent/status：徽标不许谎报，判据全来自配置");
  // 没接上游时该报哪一档，取决于这台机器有没有配大模型 Key —— 闸门不能假设答案，
  // 只能断言"两栈一致"与"上游不在场就绝不报 agentscope"。写死 demo 会在有 Key 的机器上假红。
  const noUpstreamMode = (process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY) ? "live" : "demo";
  console.log(`    （本机 ${process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY ? "有" : "没有"} DEEPSEEK_API_KEY → 无上游时应报 ${noUpstreamMode}）`);
  const [stN, stJ] = await Promise.all([
    call(NODE, "GET", "/api/agent/status"), call(JAVA, "GET", "/api/agent/status"),
  ]);
  check(stN.status === 200 && stJ.status === 200 && stN.json?.mode === noUpstreamMode
    && stJ.json?.mode === noUpstreamMode && stN.json?.ok === true && stJ.json?.ok === true,
    "没配上游 → 两栈按同一条判据降档（有大模型 Key 就 live，没有就 demo，绝不 agentscope）",
    () => `node=${stN.json?.mode} java=${stJ.json?.mode}`);
  const [stAn, stAj] = await Promise.all([
    call(ANODE, "GET", "/api/agent/status"), call(AJAVA, "GET", "/api/agent/status"),
  ]);
  check(stAn.json?.mode === "agentscope" && stAj.json?.mode === "agentscope",
    "配了上游且 /health 探活成功（夹具应答） → 两栈都报 agentscope",
    () => `node=${stAn.json?.mode} java=${stAj.json?.mode}`);
  await closeOnce(); // 上游死了：探活必须在 1.2 秒内失败并降档，不能挂着
  const [deadN, deadJ] = await Promise.all([
    call(ANODE, "GET", "/api/agent/status"), call(AJAVA, "GET", "/api/agent/status"),
  ]);
  check(deadN.json?.mode !== "agentscope" && deadJ.json?.mode !== "agentscope"
    && deadN.json?.mode === deadJ.json?.mode && deadN.status === 200 && deadJ.status === 200,
    "上游死了 → 两栈都在 1.2 秒内降档且落到同一档（宁可少报，不可谎报）",
    () => `node=${deadN.json?.mode}/${deadN.status} java=${deadJ.json?.mode}/${deadJ.status}`);
  await listen();

  /* ---------- 2 入参形状 ---------- */
  console.log("\n## 2 入参校验：坏 JSON 退化成空对象，由 mode 校验给出那条 400");
  for (const [label, body] of [
    ["没有 body → mode 校验先兜", undefined],
    ["mode 不在四档内", { mode: "summarize" }],
    ["mode 是数字 → String() 之后仍不在档内", { mode: 5 }],
    ["mode 是对象", { mode: { a: 1 } }],
    ["坏 JSON → 同一条 400，不是书房那批的「请求格式有误」", "{not json"],
  ]) {
    const [n, j] = await Promise.all([write(NODE, body, writer), write(JAVA, body, writer)]);
    check(n.status === 400 && j.status === 400
      && n.json?.error === "mode 须为 continue | polish | title | topic"
      && j.json?.error === n.json?.error, label,
    () => `node=${n.status}/${n.json?.error ?? n.text.slice(0, 40)} java=${j.status}/${j.json?.error ?? j.text.slice(0, 40)}`);
  }
  const [longN, longJ] = await Promise.all([
    write(NODE, { mode: "continue", draft: "x".repeat(100_001) }, writer),
    write(JAVA, { mode: "continue", draft: "x".repeat(100_001) }, writer),
  ]);
  check(longN.status === 400 && longJ.status === 400
    && longN.json?.error === "草稿过长（上限 10 万字）" && longJ.json?.error === longN.json?.error,
    "draft 超 10 万字 → 400（v18.0 的入参收口，防几十 MB body 全量进内存再转发上游）",
    () => `node=${longN.json?.error} java=${longJ.json?.error}`);
  const [edgeN, edgeJ] = await Promise.all([
    write(NODE, { mode: "title", draft: "x".repeat(100_000) }, writer),
    write(JAVA, { mode: "title", draft: "x".repeat(100_000) }, writer),
  ]);
  check(edgeN.status === 200 && edgeJ.status === 200,
    "恰好 10 万字在上限之内（判据是 >，不是 ≥）", () => `${edgeN.status}/${edgeJ.status}`);
  const [anonN, anonJ] = await Promise.all([
    write(NODE, { mode: "continue" }), write(JAVA, { mode: "continue" }),
  ]);
  check(anonN.status === 401 && anonJ.status === 401
    && anonN.json?.error === "登录后才能使用 AI 写作助手" && anonJ.json?.error === anonN.json?.error,
    "未登录 → 401，两栈同文案", () => `node=${anonN.json?.error} java=${anonJ.json?.error}`);

  /* ---------- 3 模板兜底逐字节 ---------- */
  console.log("\n## 3 模板兜底：四段文本两栈逐字节一致，而且一个墨点都不扣");
  const balBeforeDemo = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  const ledBeforeDemo = await ledgerRows();
  for (const mode of MODES) {
    const [n, j] = await Promise.all([
      write(NODE, { mode, draft: "我的草稿开头" }, writer),
      write(JAVA, { mode, draft: "我的草稿开头" }, writer),
    ]);
    check(n.status === 200 && j.status === 200 && typeof n.json?.text === "string"
      && n.json.text.length > 40 && n.json.text === j.json.text,
      `${mode}：兜底文本两栈逐字节相同`,
      () => `node=${JSON.stringify(n.json?.text?.slice(0, 20))}… java=${JSON.stringify(j.json?.text?.slice(0, 20))}…`);
    demoText[mode] = n.json?.text;
    check(JSON.stringify(n.keys) === JSON.stringify(j.keys)
      && n.json.fallback === true && n.json.aiGenerated === true
      && n.json.cost === PRICES[mode] && n.json.label === LABELS[mode]
      && n.json.pointsNote === "模板兜底 · 本次不扣墨水",
      `${mode}：键序与六个字段全一致（含 fallback:true 与「本次不扣墨水」）`,
      () => `${JSON.stringify(n.keys)} vs ${JSON.stringify(j.keys)}`);
  }
  const balAfterDemo = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  const ledAfterDemo = await ledgerRows();
  check(balAfterDemo === balBeforeDemo && ledAfterDemo === ledBeforeDemo,
    "八次兜底之后余额一字不动、流水零新增（「兜底必不扣墨」是这次计费整改的全部意义）",
    () => `Δ余额=${balAfterDemo - balBeforeDemo} Δ流水=${ledAfterDemo - ledBeforeDemo}`);

  /* ---------- 4 只读探针 ---------- */
  console.log("\n## 4 探针拦住之后：402 文案带精确数字，且一次都不问上游");
  await conn.query("UPDATE users SET points_balance = 3 WHERE id = ?", [uid]);
  upstreamHits.length = 0;
  for (const [label, base, cookie, mode, need] of [
    ["Node", NODE, writer, "continue", 15], ["Java", JAVA, writer, "continue", 15],
  ]) {
    const r = await write(base, { mode, draft: "x" }, cookie);
    check(r.status === 402 && r.json?.error === `积分不足（余额 3，本次需 ${need}）`,
      `${label}：余额 3 打 ${mode}（需 ${need}）→ 402 且数字精确`,
      () => `${r.status}/${r.json?.error ?? r.text.slice(0, 40)}`);
  }
  check(upstreamHits.length === 0,
    "被探针拦住的请求**一次都没到上游**（否则用户白等、平台白烧 token）",
    () => `上游收到 ${upstreamHits.length} 次`);
  const [tN, tJ] = await Promise.all([
    write(ANODE, { mode: "title", draft: "x" }, writerA),
    write(AJAVA, { mode: "title", draft: "x" }, writerA),
  ]);
  check(tN.status === 402 && tJ.status === 402
    && tN.json?.error === "积分不足（余额 3，本次需 5）" && tJ.json?.error === tN.json?.error,
    "档位价 5 也按同一判据（3 < 5）：402 文案里的数字跟着档位价走，不是硬编码 15",
    () => `node=${tN.json?.error} java=${tJ.json?.error}`);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [balance, uid]);

  /* ---------- 5 上游真产出才扣墨 ---------- */
  console.log("\n## 5 上游给出非空文本 → 扣款 + 流水；上游坏态 → 兜底且零扣墨");
  async function round(base, mode, body) {
    const bal0 = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
    const led0 = await ledgerRows();
    const r = await write(base, { mode, ...body }, writerA);
    const bal1 = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
    const row = await only(`SELECT delta, reason FROM point_ledger
      WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT 1`, [uid, mark]);
    if (paid(r)) { charged += 1; chargedSum += PRICES[mode]; }
    return { r, bal1, delta: bal1 - bal0, ledger: led0, row };
  }
  upstreamMode = "ok";
  const paidN = await round(ANODE, "continue", { draft: "夹具计费轮" });
  check(paid(paidN.r) && paidN.delta === -15 && paidN.row?.reason === "AI写作·续写"
    && paidN.row?.delta === -15
    && paidN.r.json.pointsNote === `已扣 15 滴墨水 · 余额 ${paidN.bal1}`
    && String(paidN.r.json.text).startsWith("【夹具生成·continue】"),
    "Node 侧真扣一轮：-15、一条「AI写作·续写」流水、note 里的余额与库内一致、无 fallback 键",
    () => `Δ=${paidN.delta} 流水=${JSON.stringify(paidN.row)} note=${paidN.r.json?.pointsNote}`);
  const paidJ = await round(AJAVA, "continue", { draft: "夹具计费轮" });
  check(paid(paidJ.r) && paidJ.delta === -15 && paidJ.row?.reason === "AI写作·续写"
    && paidJ.r.json.text === paidN.r.json.text,
    "Java 侧同一档：扣墨金额、流水 reason、产出文本与 Node 完全同式",
    () => `Δ=${paidJ.delta} 流水=${JSON.stringify(paidJ.row)}`);
  const sent = upstreamHits[upstreamHits.length - 1] ?? {};
  check(sent.mode === "continue" && sent.draft === "夹具计费轮" && sent.author === "博主",
    "上游收到的请求体：mode/draft 原样、author 默认「博主」", () => JSON.stringify(sent).slice(0, 120));
  upstreamHits.length = 0;
  await round(AJAVA, "polish", { author: "名".repeat(60) });
  const sentLong = upstreamHits[0] ?? {};
  check(sentLong.author === "名".repeat(40)
    && String(sentLong.draft).startsWith("（作者尚未写下草稿，主题："),
    "author 裁到 40 字、draft 缺省时替它拼一条主题占位（Node 同式）",
    () => `author=${String(sentLong.author ?? "").length} 字 draft=${String(sentLong.draft).slice(0, 20)}`);

  // 类型收口：JSON 允许 draft/author 是数字、数组、对象、布尔，两栈必须把同一个请求收成同一个字符串。
  // Node 原本在这里是一个未捕获的 TypeError → 500（`(5).trim()`），Java 一直安静地按 String() 取值，
  // 于是"换个入口"会改状态码。用 garbage 档跑：这里断言的是**上游收到了什么**，不该真扣墨，
  // 所以它也不会惊动 §7 的账实核对。
  upstreamMode = "garbage";
  const COERCIONS = [
    ["数字当草稿", { mode: "polish", draft: 5, author: 7 }, "5", "7"],
    ["数组按 join(\",\") 收", { mode: "polish", draft: ["甲", "乙"], author: true }, "甲,乙", "true"],
    ["对象成 [object Object]", { mode: "title", draft: true, author: { a: 1 } }, "true", "[object Object]"],
  ];
  for (const [label, payload, wantDraft, wantAuthor] of COERCIONS) {
    upstreamHits.length = 0;
    await Promise.all([write(ANODE, payload, writerA), write(AJAVA, payload, writerA)]);
    check(upstreamHits.length === 2 && upstreamHits.every((h) => h
      && h.draft === wantDraft && h.author === wantAuthor),
      `${label} → 两栈转发给上游的字符串一模一样（且都不扣墨）`,
      () => upstreamHits.map((h) => JSON.stringify({ d: h?.draft, a: h?.author })).join(" "));
  }
  upstreamMode = "ok";

  for (const [mode, why, m] of [
    ["polish", "上游 text 是空白", "blank"],
    ["title", "上游回 500", "error"],
    ["topic", "上游返回不是 JSON", "garbage"],
  ]) {
    upstreamMode = m; // 必须在**这一档的两轮之前**拨好，否则跑的还是上一档的坏态
    for (const [label, base] of [["Java", AJAVA], ["Node", ANODE]]) {
      const bad = await round(base, mode, { draft: "坏态轮" });
      check(bad.r.status === 200 && bad.r.json?.fallback === true
        && bad.delta === 0 && bad.r.json.text === demoText[mode],
        `${label}：${why} → 落模板兜底，余额一字不动`,
        () => `Δ=${bad.delta} status=${bad.r.status} note=${bad.r.json?.pointsNote}`);
    }
  }
  upstreamMode = "ok";

  /* ---------- 6 并发双花 ---------- */
  console.log("\n## 6 六路并发：探针不是防线，FOR UPDATE 才是");
  await conn.query("UPDATE users SET points_balance = 40 WHERE id = ?", [uid]); // 只够两次
  const raced = await Promise.all(Array.from({ length: 6 }, () =>
    write(AJAVA, { mode: "continue", draft: "并发轮" }, writerA)));
  const balRace = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  const won = raced.filter(paid).length;
  charged += won;
  chargedSum += 15 * won; // 并发这一轮全是 continue（15），扣了几次就该进几次的钱
  check(raced.every((r) => r.status === 200 || r.status === 402)
    && won === 2 && balRace === 10,
    "六路并发只有两路真扣成功、四路 402、没有一路 500：余额 40 → 10",
    () => `成功=${won} 状态=${raced.map((r) => r.status).join(",")} 余额=${balRace}`);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [balance, uid]);

  /* ---------- 7 账实核对 ---------- */
  console.log("\n## 7 每一笔扣墨恰好对应一次成功产出，反之亦然");
  const ledgerNow = await only(`SELECT COUNT(*) AS n, IFNULL(SUM(delta),0) AS s
    FROM point_ledger WHERE user_id = ? AND id > ? AND reason LIKE 'AI写作·%'`, [uid, mark]);
  check(Number(ledgerNow?.n) === charged,
    `流水条数 == 全场判定「已扣费」的次数（${charged} 次），一条不多一条不少`,
    () => `流水=${ledgerNow?.n} 判定=${charged}`);
  check(Number(ledgerNow?.s) === -chargedSum,
    `Σ流水 == 档位价之和 −${chargedSum}（余额被我手工复原过，所以账实核对只能看流水本身）`,
    () => `Σ=${ledgerNow?.s} 期望=${-chargedSum}`);
  check(await num(`SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND id > ?
    AND reason NOT LIKE 'AI写作·%'`, [uid, mark]) === 0,
    "本次没有在别的 reason 下偷偷记账（清场只按 id 区间删，键写歪就会漏）");
}
