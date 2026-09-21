#!/usr/bin/env node
// 检索侧付费墙探针：证明"未解锁的付费正文，既搜不到、也摘不出"。
//
// 为什么单独立一道闸门：/api/search 的对拍在游客身份下两侧都是"搜不到"，属于共同沉默，
// 证不了防得住。这里刻意拿**只出现在付费正文深处**的词去搜，四种身份各打一遍两栈：
//   · 无权读者（游客 / 登录未购非作者）必须 0 命中——若命中即说明正文仍可被当 oracle 探测；
//   · 有权读者（作者本人 / 已购 / 管理员）必须命中且 hit 只给 120 字窗口；
//   · 两栈结果必须逐字段一致。
//
//   node scripts/search-leak-probe.mjs <付费文 slug>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
// 地址优先级：shell 环境变量 > .env > 默认（与 paywall-probe 同一条规则）。
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";

const slug = (process.argv[2] ?? "").replace(/^\/+/, "");
if (!slug) {
  console.error("用法：node scripts/search-leak-probe.mjs <付费文 slug>");
  process.exit(2);
}

/** 取正文第 7 行之后第一个足够独特的词——前 6 行是付费墙外的预览，用它搜不出问题。 */
async function deepWord() {
  const mysql = (await import("mysql2/promise")).default;
  const conn = await mysql.createConnection(env.DATABASE_URL);
  const [rows] = await conn.query(
    "SELECT md_content AS md, unlock_price AS price FROM articles WHERE slug = ? LIMIT 1",
    [slug]
  );
  await conn.end();
  const row = rows[0];
  if (!row) throw new Error(`找不到文章 ${slug}`);
  if (!Number(row.price)) throw new Error(`${slug} 未定价（${row.price}），这道探针要求付费文`);
  const lines = String(row.md).split("\n");
  if (lines.length <= 6) throw new Error(`${slug} 正文不足 6 行，付费墙外没有可对比的深度`);
  for (const line of lines.slice(6)) {
    for (const word of line.split(/[^\p{Script=Han}]+/u)) {
      const w = word.trim();
      if (w.length >= 4) return { word: w.slice(0, 8), author: Number(row.author), preview: lines.slice(0, 6).join("\n") };
    }
  }
  throw new Error(`${slug} 第 7 行之后找不到可用于检索的中文词`);
}

async function cookieOf(base, email, password) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`在 ${base} 登录 ${email} 失败：${JSON.stringify(body)}`);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("ink_session="));
}

async function hit(base, cookie, q) {
  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie: cookie ?? "" }, cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!body) return { status: res.status, count: -1, hit: null };
  const row = (body.results ?? []).find((r) => r.slug === slug);
  return {
    status: res.status,
    count: (body.results ?? []).length,
    matched: Boolean(row),
    hitChars: row?.hit == null ? 0 : String(row.hit).length,
  };
}

const { word, preview } = await deepWord();
const inPreview = [...word].every((ch) => preview.includes(ch));

const CASES = [
  ["游客", null, null],
  ["运营(管理员)", env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD],
  ["作者/写手", env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD],
  ["登录但未购非作者", env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD],
];

let bad = 0;
let anyMatch = false;
console.log(`slug=${slug}  探针词=「${word}」  （取自已隐藏的第 7 行之后）\n`);
for (const [label, email, password] of CASES) {
  const ckNode = email ? await cookieOf(NODE, email, password) : null;
  const ckJava = email ? await cookieOf(JAVA, email, password) : null;
  const n = await hit(NODE, ckNode, word);
  const j = await hit(JAVA, ckJava, word);
  anyMatch ||= n.matched;
  const problems = [];
  if (JSON.stringify(n) !== JSON.stringify(j)) problems.push("两栈不一致");
  // 游客对付费文必然无权（无购买记录可言），命中即说明隐藏正文仍被当成检索语料。
  if (label === "游客" && n.matched) problems.push("游客命中了隐藏正文里的词（正文成了可探测的 oracle）");
  if (n.hitChars > 120) problems.push(`摘录超出 120 字窗口：${n.hitChars}`);
  if (problems.length) bad++;
  console.log(
    `${problems.length ? "FAIL" : "PASS"}  ${label.padEnd(10)} node=${JSON.stringify(n)} java=${JSON.stringify(j)}`
  );
  for (const p of problems) console.log(`        · ${p}`);
}
// 没有任何身份命中 = 这个词压根搜不到，四条"不命中"全是空话，探针本身失效。
if (!anyMatch) {
  bad++;
  console.log(`FAIL  探针词「${word}」对所有身份都不命中——它可能落在 SQL 不检索的位置，换词重跑。`);
}
if (inPreview) console.log("提示：探针词的每个字都出现在前 6 行预览里，摘要匹配会干扰判定，换个更深的词更严。");
console.log(`\n合计 ${CASES.length} 个身份，${bad} 个问题`);
process.exit(bad ? 1 : 0);
