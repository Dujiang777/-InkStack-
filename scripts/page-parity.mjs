#!/usr/bin/env node
// 页面级双轨对比：同一个页面在"Node 直连 MySQL"与"经 Java 数据源"两种取数下渲染，
// 比较读者真正看到的东西。
//
// 为什么不用整段 HTML 逐字节比：两个 dev 实例的 <script> 带各自的编译时间戳/webpack chunk，
// 差异全来自 dev 外壳，会把真实的数据差异淹掉。所以比"可见文本 + 链接序列 + 结构计数"。
//
//   node scripts/page-parity.mjs --base-node=http://localhost:3200 --base-java=http://localhost:3300 / /article/xxx
import { inspect } from "node:util";

const argv = process.argv.slice(2);
const opts = { node: "http://localhost:3200", java: "http://localhost:3300", paths: [] };

/** Git Bash(MSYS) 会把 POSIX 根映射成 Git 安装目录："/hot" → "D:/Git/hot"、"/" → "D:/Git/"。 */
function pagePath(arg) {
  if (!/^[A-Za-z]:[/\\]/.test(arg)) return arg.startsWith("/") ? arg : "/" + arg;
  let p = arg.replace(/^[A-Za-z]:[/\\]/, "/");
  p = p.replace(/^\/[^/\\]*(?=[/\\]|$)/, "");
  return p.startsWith("/") ? p : "/" + p;
}

for (const a of argv) {
  if (a.startsWith("--base-node=")) opts.node = a.slice(12);
  else if (a.startsWith("--base-java=")) opts.java = a.slice(12);
  else opts.paths.push(pagePath(a));
}
if (!opts.paths.length) {
  console.error("至少给一个页面路径");
  process.exit(2);
}

/** 剥掉脚本与样式后的可见文本，以及按出现顺序排列的链接与结构标记计数。 */
function shape(html) {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const links = [...noScript.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => `${m[1]}|${m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}`);
  const text = noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const count = (sel) => (noScript.match(new RegExp(sel, "gi")) ?? []).length;
  return {
    text,
    links,
    cards: count(/class="[^"]*\bfeed-card\b/),
    headings: count(/<h[1-3]\b/),
    imgs: count(/<img\b/),
    bytes: html.length,
  };
}

async function get(base, p) {
  const res = await fetch(base + p, { headers: { "user-agent": "inkstack-parity" }, cache: "no-store" });
  return { status: res.status, html: await res.text() };
}

let bad = 0;
for (const p of opts.paths) {
  const [n, j] = [await get(opts.node, p), await get(opts.java, p)];
  const a = shape(n.html), b = shape(j.html);
  const problems = [];
  // 两侧都 500 也"一致"，但那不是通过——共同失败必须显式判负，否则闸门会替 bug 背书。
  if (n.status !== 200 || j.status !== 200) {
    const snippet = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
    problems.push(`页面未正常渲染：node=${n.status} java=${j.status}`);
    if (n.status !== 200) problems.push(`  node 侧: ${snippet(n.html)}`);
    if (j.status !== 200) problems.push(`  java 侧: ${snippet(j.html)}`);
  }
  if (a.text !== b.text) {
    let i = 0;
    while (i < Math.min(a.text.length, b.text.length) && a.text[i] === b.text[i]) i++;
    problems.push(`可见文本在第 ${i} 字符起不同`);
    problems.push(`  node: …${JSON.stringify(a.text.slice(Math.max(0, i - 40), i + 80))}`);
    problems.push(`  java: …${JSON.stringify(b.text.slice(Math.max(0, i - 40), i + 80))}`);
  }
  if (inspect(a.links) !== inspect(b.links)) {
    const onlyN = a.links.filter((l) => !b.links.includes(l));
    const onlyJ = b.links.filter((l) => !a.links.includes(l));
    problems.push(`链接序列不同：只在 node=${onlyN.length} 条，只在 java=${onlyJ.length} 条`);
    for (const l of onlyN.slice(0, 3)) problems.push(`  仅 node: ${l}`);
    for (const l of onlyJ.slice(0, 3)) problems.push(`  仅 java: ${l}`);
  }
  for (const k of ["cards", "headings", "imgs"]) {
    if (a[k] !== b[k]) problems.push(`${k} 计数 ${a[k]} vs ${b[k]}`);
  }
  if (problems.length) bad++;
  console.log(`${problems.length ? "FAIL" : "PASS"}  ${p}  [node ${n.status} / java ${j.status}]` +
    `  文本 ${a.text.length} vs ${b.text.length} 字  链接 ${a.links.length} vs ${b.links.length} 条  卡片 ${a.cards} vs ${b.cards}`);
  for (const line of problems.slice(0, 8)) console.log(`      · ${line}`);
}
console.log(`\n比对 ${opts.paths.length} 个页面，${bad} 个不一致`);
process.exit(bad ? 1 : 0);
