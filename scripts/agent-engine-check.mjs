#!/usr/bin/env node
// P6c 引擎闸门：Java 侧 Spring AI 智能体顶掉 Python 的 agent-service，测的是"替得对不对"。
//
// 这一道与闸门 14 的分工不同：14 测的是**双栈一致**（Node 与 Java 必须给同一个产物），
// 而引擎是只存在于 Java 侧的第四通道，没有对岸可比。所以这里全部换成**绝对判据**：
//   ① 检索工具真的被调用，而且喂给模型的语料带付费墙与审核闸门——
//      Python 版那条 SQL 两条都缺，等于让分身把没解锁的付费正文念给读者听。
//      判据写成一对：先用 Python 的原句查出这条稿子（证明"它本来会被喂进去"），
//      再证明引擎发给模型的那份里**没有**它。只查后半句是空断言，一查就绿。
//   ② NDJSON 契约不因为换了引擎而变形：delta 拼回是模型的整段回答、末尾恰好一条 cite、
//      cite 是从「依据：《…》」抽出来的、切块宽度沿用 Python 的 max(1, len // 40)。
//   ③ 钱还是只动一次，而且停在同一个时刻：探针拦住 → 上游 0 请求；上游 500 → 落演示档、零扣墨。
//   ④ /api/ai/write 走引擎：提示词与 3000 字裁剪照原样、坏态落模板不扣墨。
//
//   node scripts/agent-engine-check.mjs          跑完清场
//   node scripts/agent-engine-check.mjs --keep   保留现场
//
// 前提：
//   ① 一个开着引擎的 Java 实例（不需要 Node 对岸，引擎是 Java 侧独有的）：
//        cd server && JAVA_HOME=<jdk17> mvn -o -s settings.xml spring-boot:run \
//          -Dspring-boot.run.arguments="--server.port=3192 \
//            --inkstack.agent.engine=spring-ai \
//            --inkstack.agent.service-url= \
//            --inkstack.agent.deepseek-key= \
//            --inkstack.agent.model.base-url=http://127.0.0.1:4702/v1 \
//            --inkstack.agent.model.api-key=gate-fake-key \
//            --inkstack.agent.model.name=deepseek-chat"
//      service-url 与 deepseek-key 必须留空：那样"引擎失败之后落到哪一档"才是确定的演示档，
//      而不是去敲某台真服务或真大模型。model.api-key 是假的，base-url 指向本闸门自己的夹具。
//   ② DATABASE_URL 指向克隆库 inkstack_j：会真建文章、真扣墨、真写流水，跑完全部清掉。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const JAVA = process.env.ENGINE_JAVA || "http://localhost:3192";
const KEEP = process.argv.includes("--keep");
const FIXTURE_PORT = Number(process.env.ENGINE_FIXTURE_PORT || 4702);
const QA_COST = 5;
const AUTHOR_ID = 5;          // chenyu@inkstack.dev：夹具文章的作者，不是提问的人
// 三个哨兵是刻意挑的**稀有中文串**：ngram 全文检索按二元组打分，用 FREE-SENTINEL 这种
// 含大量公共二元组的写法会让库里现成的文章也命中，检索集一被挤开，下面的排除断言就变成空跑。
const SENTINELS = {
  free: "墨栈哨兵甲Q1",
  paid: "墨栈哨兵乙Q2",
  pending: "墨栈哨兵丙Q3",
};
// 工具这一轮要检索的话：三个哨兵一起上，让三篇夹具文章都进候选（各命中一个稀有词、库里文章一个都不命中）
const TOOL_QUERY = `${SENTINELS.free} ${SENTINELS.paid} ${SENTINELS.pending}`;

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

async function call(method, url, body, cookie) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(JAVA + url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get("content-type") ?? "" };
}

async function login(email, password) {
  const res = await fetch(JAVA + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error(`登录失败 ${res.status}`);
  return cookie;
}

/** 流式读完一条 NDJSON：返回帧序列与"分了几块到达"。 */
async function askStream(body, cookie) {
  const h = { "content-type": "application/json" };
  if (cookie) h.cookie = cookie;
  const res = await fetch(JAVA + "/api/agent/ask", {
    method: "POST", headers: h, body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.body || contentType.includes("application/json")) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, frames: [], text, chunks: 1, contentType, bad: 0 };
  }
  const dec = new TextDecoder();
  let buf = "";
  let chunks = 0;
  for await (const part of res.body) {
    chunks++;
    buf += dec.decode(part, { stream: true });
  }
  const frames = [];
  let bad = 0;
  for (const line of buf.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t === "[DONE]") { bad++; continue; }
    try { frames.push(JSON.parse(t)); } catch { bad++; }
  }
  return { status: res.status, json: null, frames, text: buf, chunks, contentType, bad };
}
const streamed = (r) => r.frames.filter((f) => f.type === "delta").map((f) => f.text).join("");

/* ==================== OpenAI 兼容夹具 ==================== */

const modelHits = [];
let askMode = "react";   // react | final | error | blank
let writeMode = "ok";    // ok | error
let reactRound = 0;
const FINAL_TEXT = "因为规范 §2.2.4 要求回调排在平台代码之外。\n依据：《手写 Promise》第 2 节「then 的微任务语义」";

function completion(message, finish) {
  return JSON.stringify({
    id: "chatcmpl-fixture", object: "chat.completion", created: 1,
    model: "deepseek-chat",
    choices: [{ index: 0, message, finish_reason: finish ?? "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("夹具没有这条路径");
    return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = { unparsable: raw.slice(0, 60) }; }
    modelHits.push(parsed);
    const isWrite = String(parsed?.messages?.[0]?.content ?? "").includes("写作助手");
    if (isWrite) {
      if (writeMode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "夹具模拟写作通道 500" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion({ role: "assistant", content: "夹具生成的润色结果" }));
      return;
    }
    if (askMode === "error") {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "夹具模拟分身引擎 502" }));
      return;
    }
    if (askMode === "blank") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion({ role: "assistant", content: "   \n\t " }));
      return;
    }
    const wantTool = askMode === "react" && reactRound === 0;
    if (wantTool) {
      reactRound++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion({
        role: "assistant", content: null,
        tool_calls: [{
          id: "call_fx_1", type: "function",
          function: { name: "searchBlogArticles", arguments: JSON.stringify({ question: TOOL_QUERY }) },
        }],
      }, "tool_calls"));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(completion({ role: "assistant", content: FINAL_TEXT }));
  });
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

/* ==================== 夹具文章与清场 ==================== */

const PARAGRAPH = (marker) => `这一段是闸门 15 的哨兵正文 ${marker}。它必须足够长，因为检索层把三十个字以下的段落直接丢掉，`
  + `短了就会在挑选阶段消失，测试跟着变成空跑。`;

const planted = [];
async function plantArticles() {
  await wipeArticles();
  const rows = [
    ["P6C 免费札记", "p6c-free-" + Date.now(), 0, "approved", SENTINELS.free],
    ["P6C 付费正文", "p6c-paid-" + Date.now(), 60, "approved", SENTINELS.paid],
    ["P6C 未过审稿", "p6c-pending-" + Date.now(), 0, "pending", SENTINELS.pending],
  ];
  for (const [title, slug, price, review, marker] of rows) {
    await conn.query(
      `INSERT INTO articles (author_id, slug, title, md_content, summary, status, review_status,
                             unlock_price, tags, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?, ?, '[]', NOW())`,
      [AUTHOR_ID, slug, title, PARAGRAPH(marker) + "\n\n" + PARAGRAPH(marker), title, review, price]
    );
    planted.push(slug);
  }
}
async function wipeArticles() {
  if (!planted.length) return;
  await conn.query("DELETE FROM articles WHERE slug IN (?)", [planted]);
  planted.length = 0;
}

const state = {};
async function cleanup() {
  const bits = [];
  const plantedCount = planted.length;
  await wipeArticles().catch((e) => bits.push(`删文章失败 ${e.message}`));
  if (state.uid) {
    const rows = await num("SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND id > ?",
      [state.uid, state.mark]);
    await conn.query("DELETE FROM point_ledger WHERE user_id = ? AND id > ?", [state.uid, state.mark]);
    await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [state.balance, state.uid]);
    const qa = await num("SELECT COUNT(*) FROM agent_qa WHERE id > ?", [state.qaMark]);
    await conn.query("DELETE FROM agent_qa WHERE id > ?", [state.qaMark]);
    bits.push(`余额复原 ${state.balance}、删流水 ${rows} 条、删问答 ${qa} 条`);
  }
  bits.push(`删夹具文章 ${plantedCount} 篇`);
  return bits.join("、");
}

try {
  await listen();
  await suit();
} catch (e) {
  fail++;
  console.error(`闸门自身异常：${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  await closeOnce();
  if (Object.keys(state).length || planted.length) {
    try {
      console.log(`\n已清场：${await cleanup()}`);
    } catch (e) {
      console.error("清场失败，克隆库可能残留夹具：", e.message);
      fail++;
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
  const snapshot = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  const mark = await num("SELECT IFNULL(MAX(id),0) FROM point_ledger WHERE user_id = ?", [uid]);
  const qaMark = await num("SELECT IFNULL(MAX(id),0) FROM agent_qa");
  Object.assign(state, { uid, balance: snapshot, mark, qaMark });
  const balance = snapshot < 120 ? snapshot + 900 : snapshot;
  if (balance !== snapshot) {
    await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [balance, uid]);
    console.log(`    （账号只有 ${snapshot} 点，先垫到 ${balance} 再跑，收尾照旧收回）`);
  }

  const status = await call("GET", "/api/agent/status");
  if (status.json?.mode !== "spring-ai") {
    throw new Error(`实例没在引擎档（mode=${status.json?.mode}）——按本文件头部 ① 起一个 --server.port=3192 的实例`);
  }
  const me = await login(env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD);
  await plantArticles();
  // ngram 全文索引刚写完可能还没进倒排，检索类用例先确认"查得到"再往下跑
  const findable = await num("SELECT COUNT(*) FROM articles WHERE slug = ? AND MATCH(title, md_content) AGAINST(? IN NATURAL LANGUAGE MODE)",
    [planted[0], SENTINELS.free]);
  if (!findable) throw new Error("全文索引还没能查到刚插入的夹具文章，检索类用例跑不了（稍后重跑）");

  const ledgerRows = () => num(
    "SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND id > ?", [uid, mark]);

  /* ---------- 1 工具真的被调用，语料还带付费墙与审核闸门 ---------- */
  console.log("\n## 1 检索工具：跑起来了，而且没把付费正文与未过审稿喂给模型");
  modelHits.length = 0;
  reactRound = 0;
  askMode = "react";
  const r1 = await askStream({ question: "为什么 then 要进微任务？", author: "陈屿" }, me);
  check(r1.status === 200 && r1.contentType.startsWith("application/x-ndjson") && r1.bad === 0
    && r1.frames.filter((f) => f.type === "cite").length === 1
    && r1.frames.at(-1).type === "cite",
    "问答以 NDJSON 收尾，末尾恰好一条 cite",
    () => `${r1.status}/${r1.contentType} 帧=${r1.frames.length}`);
  const toolRound = modelHits[1] ?? {};
  const toolMessages = (toolRound.messages ?? []).filter((m) => m.role === "tool");
  const fedToModel = toolMessages.map((m) => String(m.content ?? "")).join("\n");
  check(modelHits.length >= 2 && toolMessages.length === 1
    && String(modelHits[0].messages?.[0]?.content).includes("数字分身")
    && String(modelHits[0].messages?.[0]?.content).includes("searchBlogArticles"),
    "模型先拿到分身 system prompt 与工具清单，第二轮才带着工具结果继续——ReAct 那一圈没有变成一次直连",
    () => `命中 ${modelHits.length} 次，工具消息 ${toolMessages.length} 条`);
  // Python 版那条**缺防护**的 SQL 原样跑一遍（同一句查询词）：它查出来的就是"照旧实现会被喂进语料的东西"。
  // 少了这一步，下面的"引擎没发给模型"在任何时候都成立——检索集里本来就没有它，测的是空气。
  const weakRows = await many(
    `SELECT title, SUBSTRING(md_content, 1, 2000) AS md FROM articles
      WHERE status = 'published'
        AND MATCH(title, md_content) AGAINST(? IN NATURAL LANGUAGE MODE)
      LIMIT 3`, [TOOL_QUERY]);
  const weakText = weakRows.map((row) => String(row.md)).join("\n");
  check(weakRows.length === 3 && weakText.includes(SENTINELS.free)
    && weakText.includes(SENTINELS.paid) && weakText.includes(SENTINELS.pending),
    "旧 SQL 的检索集正好是三篇夹具稿（库里现成的文章一篇都没命中，稀有中文哨兵选对了）",
    () => `命中 ${weakRows.length} 篇：${weakRows.map((r) => r.title).join(" / ")}`);
  check(fedToModel.includes(SENTINELS.free),
    "免费已过审的那篇确实喂给了模型（下面两条排除断言因此不是空跑）",
    () => fedToModel.slice(0, 60));
  for (const [label, marker] of [["付费未解锁", SENTINELS.paid], ["未过审", SENTINELS.pending]]) {
    check(weakText.includes(marker) && !fedToModel.includes(marker),
      `${label}的稿子：Python 版 SQL 查得到（所以它是真洞），引擎版没发给模型`,
      () => `旧 SQL 查到=${weakText.includes(marker)} 引擎语料含它=${fedToModel.includes(marker)}`);
  }
  /* ---------- 2 帧的形状与切块宽度 ---------- */
  console.log("\n## 2 契约：切块宽度沿用 Python 的 max(1, len // 40)，cite 从「依据：」里抽");
  check(streamed(r1) === FINAL_TEXT,
    "delta 拼回去就是模型的整段回答，一个字不多一个字不少",
    () => JSON.stringify(streamed(r1).slice(0, 40)));
  const step = Math.max(1, Math.floor(FINAL_TEXT.length / 40));
  const widths = r1.frames.filter((f) => f.type === "delta").map((f) => f.text.length);
  check(widths.length === Math.ceil(FINAL_TEXT.length / step)
    && widths.slice(0, -1).every((w) => w === step) && widths.at(-1) <= step,
    `切块宽度是 ${step}（整段 ${FINAL_TEXT.length} 字 / 40，最后一块可短），换引擎没换打字机速度`,
    () => `宽度=${[...new Set(widths)].join(",")} 块数=${widths.length}`);
  check(r1.frames.at(-1).citation === "《手写 Promise》第 2 节「then 的微任务语义」",
    "引用来源是从回答末尾那行「依据：《…》」抽出来的",
    () => JSON.stringify(r1.frames.at(-1).citation));

  /* ---------- 3 钱只动一次，坏态一格都不动 ---------- */
  console.log("\n## 3 计费：探针在前、扣款在产出之后，坏态一律不扣");
  const ledAfterOk = await ledgerRows();
  check(ledAfterOk === 1 && r1.status === 200,
    "一轮成功问答正好一条流水", () => `本次流水=${ledAfterOk}`);
  modelHits.length = 0;
  await conn.query("UPDATE users SET points_balance = 3 WHERE id = ?", [uid]);
  const poor = await askStream({ question: "穷轮" }, me);
  check(poor.status === 402 && poor.json?.error === "墨水不足（余额 3，本次需 5）"
    && modelHits.length === 0,
    "余额 3 → 402 且**一次都没问模型**（否则读者白等、平台白烧 token）",
    () => `${poor.status}/${poor.json?.error} 模型收到=${modelHits.length}`);
  await conn.query("UPDATE users SET points_balance = ? WHERE id = ?", [balance, uid]);

  modelHits.length = 0;
  askMode = "error";
  const balBeforeBad = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  const ledBeforeBad = await ledgerRows();
  const bad1 = await askStream({ question: "引擎坏了这一轮" }, me);
  const balAfterBad = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  const ledAfterBad = await ledgerRows();
  check(bad1.status === 200 && modelHits.length >= 1
    && balAfterBad === balBeforeBad && ledAfterBad === ledBeforeBad,
    "引擎 502 → 落演示档、零扣墨（service-url 与 deepseek-key 都留空，所以兜底一定是 demo 而不是去敲真上游）",
    () => `余额Δ=${balAfterBad - balBeforeBad} 流水Δ=${ledAfterBad - ledBeforeBad}`);
  askMode = "blank";
  const bad2 = await askStream({ question: "引擎只回空白" }, me);
  check(bad2.status === 200 && streamed(bad2) !== "" && !streamed(bad2).includes("   ")
    && (await ledgerRows()) === ledBeforeBad,
    "引擎只回空白也算没产出：落演示档、零扣墨（把空白当成品发出去还照扣，就是原来那套谎报）",
    () => `拼回=${JSON.stringify(streamed(bad2).slice(0, 20))}`);
  askMode = "react";

  const anon = await askStream({ question: "游客提问" });
  check(anon.status === 401 && anon.json?.error === "登录后才能与分身对话"
    && anon.contentType.includes("application/json"),
    "引擎档要求登录（问答要扣墨，与 live/透传同一条规矩），且 401 是普通 JSON 不是一条流",
    () => `${anon.status}/${anon.json?.error}`);
  const empty = await askStream({ question: "   " }, me);
  check(empty.status === 400 && empty.json?.error === "question 不能为空",
    "空提问仍是那条 400（先于任何模型调用）", () => `${empty.status}/${empty.json?.error}`);

  /* ---------- 4 问答流水的落库形状 ---------- */
  console.log("\n## 4 agent_qa：整段回答与引用都要落库");
  const qaRow = await only(`SELECT asker_id, question, answer, citations FROM agent_qa
    WHERE id > ? ORDER BY id DESC LIMIT 1`, [qaMark]);
  // mysql2 会把 JSON 列直接解析成数组/对象（闸门 13 真踩过），所以这里两种形状都要接住
  const cited = typeof qaRow?.citations === "string"
    ? qaRow.citations : JSON.stringify(qaRow?.citations);
  check(qaRow?.answer === FINAL_TEXT
    && cited === '["《手写 Promise》第 2 节「then 的微任务语义」"]'
    && Number(qaRow?.asker_id) === uid,
    "引擎通道把**完整回答**存了下来（Python 时代只存一个占位串，问答记录等于没留），"
    + "并挂上提问者的 id —— 成就「十问分身」按 asker_id 计数，这一列空着徽章永远不动",
    () => JSON.stringify(qaRow).slice(0, 120));

  /* ---------- 5 写作助手走引擎 ---------- */
  console.log("\n## 5 /api/ai/write：四档提示词、3000 字裁剪、坏态落模板");
  writeMode = "ok";
  modelHits.length = 0;
  const longDraft = "草".repeat(3200);
  const w1 = await call("POST", "/api/ai/write", { mode: "polish", draft: longDraft, author: "陈屿" }, me);
  const wrote = modelHits[0] ?? {};
  const balAfterWrite = await num("SELECT points_balance FROM users WHERE id = ?", [uid]);
  check(w1.status === 200 && w1.json?.text === "夹具生成的润色结果"
    && w1.json?.fallback === undefined && w1.json?.cost === 10
    && w1.json?.pointsNote === `已扣 10 滴墨水 · 余额 ${balAfterWrite}`,
    "写作档由引擎真产出、按档位扣 10，note 里的余额与库内一致且不带 fallback 键",
    () => JSON.stringify(w1.json).slice(0, 140));
  check(String(wrote.messages?.[0]?.content).includes("写作助手")
    && String(wrote.messages?.[1]?.content).includes("润色这段草稿")
    && String(wrote.messages?.[1]?.content).length === "润色这段草稿：保留原意与观点，收紧节奏、删冗余，只输出润色后的文本：\n\n".length + 3000,
    "提示词与 3000 字裁剪照抄 Python 版（草稿 3200 字进来，只有前 3000 字进模型）",
    () => `user 段长=${String(wrote.messages?.[1]?.content).length}`);
  writeMode = "error";
  const ledBeforeWriteFail = await ledgerRows();
  const w2 = await call("POST", "/api/ai/write", { mode: "title", draft: "坏态轮" }, me);
  check(w2.status === 200 && w2.json?.fallback === true
    && w2.json?.pointsNote === "模板兜底 · 本次不扣墨水"
    && (await ledgerRows()) === ledBeforeWriteFail,
    "写作档坏态 → 模板兜底、零扣墨（与双栈那一条判据同一个）",
    () => JSON.stringify(w2.json).slice(0, 120));
  writeMode = "ok";

  /* ---------- 6 收尾账实 ---------- */
  console.log("\n## 6 账实：问答 5 点、写作按档位，每一次扣墨都对得上");
  const sums = await only(`SELECT
      IFNULL(SUM(CASE WHEN reason = '分身问答' THEN -delta ELSE 0 END),0) AS qa,
      COUNT(CASE WHEN reason = '分身问答' THEN 1 END) AS qaRows,
      IFNULL(SUM(CASE WHEN reason LIKE 'AI写作·%' THEN -delta ELSE 0 END),0) AS wr,
      COUNT(CASE WHEN reason LIKE 'AI写作·%' THEN 1 END) AS wrRows
    FROM point_ledger WHERE user_id = ? AND id > ?`, [uid, mark]);
  check(Number(sums?.qaRows) === 1 && Number(sums?.qa) === QA_COST
    && Number(sums?.wrRows) === 1 && Number(sums?.wr) === 10,
    "全场扣费：问答只有一轮成功（穷轮/坏态/游客/空问都不算）× 5 点 + 写作一轮 10 点，别的都不记账",
    () => JSON.stringify(sums));
}
