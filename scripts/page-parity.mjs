#!/usr/bin/env node
// 页面级双轨对比：同一个页面在"Node 直连 MySQL"与"经 Java 数据源"两种取数下渲染，
// 比较读者真正看到的东西。
//
// 为什么不用整段 HTML 逐字节比：两个 dev 实例的 <script> 带各自的编译时间戳/webpack chunk，
// 差异全来自 dev 外壳，会把真实的数据差异淹掉。所以比"可见文本 + 链接序列 + 结构计数"。
//
//   node scripts/page-parity.mjs --base-node=http://localhost:3200 --base-java=http://localhost:3300 / /article/xxx
import { inspect } from "node:util";

import fs from "node:fs";
import path from "node:path";
import { dataSourceOf, requireDataSource } from "./gate-datasource.mjs";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);

const argv = process.argv.slice(2);
const opts = { node: "http://localhost:3200", java: "http://localhost:3300", paths: [], login: null };

/** 每次渲染内容本就不同的页面：换成抽样验"落点对不对"，见下面 rnd 分支。 */
const RANDOM_PAGES = ["/random"];

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
  else if (a.startsWith("--login=")) opts.login = a.slice(8);
  else opts.paths.push(pagePath(a));
}
if (opts.login && !["test", "writer", "probe"].includes(opts.login)) {
  console.error("--login 只接受 test / writer / probe（凭据取自本地 .env）");
  process.exit(2);
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

async function get(base, p, cookie) {
  const res = await fetch(base + p, {
    headers: { "user-agent": "inkstack-parity", ...(cookie ? { cookie } : {}) },
    cache: "no-store",
  });
  return { status: res.status, html: await res.text() };
}

/** 不跟随重定向：/random 是 307 到抽中的那篇文章，落点 location 才是这件事的原始答案。 */
async function getRedirect(base, p, cookie) {
  const res = await fetch(base + p, {
    headers: { "user-agent": "inkstack-parity", ...(cookie ? { cookie } : {}) },
    cache: "no-store", redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

/** 从 307 的落点里取 slug；不是 /article/ 就是没抽中文章。 */
function redirectedSlug(loc) {
  const m = (loc ?? "").replace(/^https?:\/\/[^/]+/, "").match(/^\/article\/([^#?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 某一站点的"公开可见文章"slug 集合（游客态列表）。
 * 随机池的校验靠它：不在列表里的文章本就不该被任何人随机撞见。
 */
const listCache = new Map();
async function publicSlugs(base, cookie) {
  if (listCache.has(base)) return listCache.get(base);
  try {
    const res = await fetch(`${base}/api/articles?limit=200`, {
      headers: { "user-agent": "inkstack-parity", ...(cookie ? { cookie } : {}) }, cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.json();
    const rows = body.articles ?? body.data ?? body.items ?? [];
    const set = new Set(rows.map((r) => String(r.slug ?? "")).filter(Boolean));
    listCache.set(base, set.size ? set : null);
    return listCache.get(base);
  } catch {
    return null;
  }
}

/**
 * 只在 node 侧登录一次，把同一枚 ink_session 同时发给两个实例。
 * 这样既比了"同一身份看到的内容"，也顺带证明 Java 数据源实例认这枚 Cookie。
 */
async function loginCookie() {
  const creds = {
    test: [env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD],
    writer: [env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD],
    probe: [env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD],
  }[opts.login];
  if (!creds || !creds[0] || !creds[1]) throw new Error(`.env 缺少 ${opts.login} 的测试凭据`);
  const res = await fetch(opts.node + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: creds[0], password: creds[1] }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`登录失败：${JSON.stringify(body)}`);
  const cookie = (res.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0]).find((c) => c.startsWith("ink_session="));
  if (!cookie) throw new Error("登录成功但没有 ink_session");
  console.log(`已登录 ${creds[0]}（两实例共用同一枚 Cookie）\n`);
  return cookie;
}

let cookie;
if (opts.login) cookie = await loginCookie();

/*
 * 起跑前先确认两台实例走的**确实是两条路**。P7d 把 DATA_VIA_JAVA 的默认从"关"翻成
 * "配了 JAVA_BASE 就走 Java"，于是参考实例也可能自己变成 Java 取数——这一来闸门会比出
 * 满屏 60/60 全绿，而它比从来就是同一条路。"闸门替不存在的一致性背书"比一盏红灯危险得多：
 * 前者会让你带着一个没被验证过的默认值去部署。两侧都要钉，见 gate-datasource.mjs。
 */
const [srcNode, srcJava] = [await dataSourceOf(opts.node), await dataSourceOf(opts.java)];
console.log(`取数路径：参考实例 ${opts.node} → ${srcNode}｜对岸实例 ${opts.java} → ${srcJava}`);
requireDataSource(opts.node, srcNode, "node");
requireDataSource(opts.java, srcJava, "java");
console.log("");

let bad = 0;
for (const p of opts.paths) {
  const [n, j] = [await get(opts.node, p, cookie), await get(opts.java, p, cookie)];
  const a = shape(n.html), b = shape(j.html);
  const problems = [];
  // 两侧都 500 也"一致"，但那不是通过——共同失败必须显式判负，否则闸门会替 bug 背书。
  if (n.status !== 200 || j.status !== 200) {
    const snippet = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
    problems.push(`页面未正常渲染：node=${n.status} java=${j.status}`);
    if (n.status !== 200) problems.push(`  node 侧: ${snippet(n.html)}`);
    if (j.status !== 200) problems.push(`  java 侧: ${snippet(j.html)}`);
  }
  /*
   * 每次渲染都抽不同文章的页面（/random 漫游记，307 到抽中那篇）：两侧比逐字或比条数
   * 都没有意义——抽到带 3 个标签的文章就比带 2 个的多一条链接，这是设计不是 bug。
   * 但"随机所以跳过"等于把这一页从闸门里删掉，Java 侧哪天返回空态、500、
   * 或把草稿/未审稿喂进随机池，都没人管。所以换成三条各自成立的断言：
   *   1) 两侧都必须 307 到一个 /article/{slug} 落点（不是 200 空壳、不是 500）；
   *   2) k 次抽样落到的**每一个** slug 都要在该栈自己的公开列表里——随机池漏进
   *      草稿 / 未过审文章时，页面照样是一篇像样的文章，只有回查列表看得见；
   *   3) k 次里必须出现过不止一篇——ORDER BY RAND() 写丢的话每次都是同一篇，
   *      上面两条照样全绿，只有这一条抓得住。
   * 抽样条数写死，不做"看着不像就重试"，免得闸门自己变成 flaky 的来源。
   */
  const rnd = RANDOM_PAGES.includes(p.replace(/\?.*$/, ""));
  if (rnd) {
    const DRAWS = 10;
    for (const [side, base] of [["node", opts.node], ["java", opts.java]]) {
      const listed = await publicSlugs(base, cookie);
      if (listed === null) { problems.push(`${side} 侧取不到公开列表，随机池无从校验`); continue; }
      const seen = [];
      for (let i = 0; i < DRAWS; i++) {
        const r = await getRedirect(base, p, cookie);
        const slug = r.status >= 300 && r.status < 400 ? redirectedSlug(r.location) : null;
        if (!slug) {
          problems.push(`${side} 侧第 ${i + 1} 次 /random 没落到文章（status=${r.status} location=${r.location || "无"}）`);
          continue;
        }
        seen.push(slug);
      }
      const distinct = new Set(seen);
      const leaks = [...distinct].filter((s) => !listed.has(s));
      if (leaks.length) problems.push(`${side} 侧随机池抽到了不在公开列表里的文章：${leaks.slice(0, 3).join(" ")}`);
      if (distinct.size < 2) {
        problems.push(`${side} 侧 ${DRAWS} 次抽样始终是同一篇（${[...distinct][0] ?? "没落到文章"}）——随机没生效`);
      }
      console.log(`      · ${side} 侧抽样 ${DRAWS} 次：${distinct.size} 篇不同文章，越池 ${leaks.length} 篇`);
    }
  } else {
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
  }
  for (const k of ["cards", "headings", "imgs"]) {
    // 随机页的结构计数天然随抽到的文章变（多一个标签就多一条链接），跨侧比它是假命题
    if (!rnd && a[k] !== b[k]) problems.push(`${k} 计数 ${a[k]} vs ${b[k]}`);
  }
  if (problems.length) bad++;
  console.log(`${problems.length ? "FAIL" : "PASS"}  ${p}  [node ${n.status} / java ${j.status}]` +
    `  文本 ${a.text.length} vs ${b.text.length} 字  链接 ${a.links.length} vs ${b.links.length} 条  ` +
    `卡片 ${a.cards} vs ${b.cards}${rnd ? "  （随机页：验抽样落点，不验逐字）" : ""}`);
  for (const line of problems.slice(0, 8)) console.log(`      · ${line}`);
}
console.log(`\n比对 ${opts.paths.length} 个页面，${bad} 个不一致`);
process.exit(bad ? 1 : 0);
