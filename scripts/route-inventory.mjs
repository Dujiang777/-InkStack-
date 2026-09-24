#!/usr/bin/env node
// 路由清单闸门：回答"今天到底能往 JAVA_ROUTES 里写哪些前缀"——而且是机器算出来的，不是人记的。
//
// 为什么需要它：middleware 的切流是**前缀级**的，一旦把 /api/series 写进 JAVA_ROUTES，
// 该前缀下的每个方法都会换人应答。而两栈在同一 URL 上的方法集合与语义并不天然相同：
// 历史上这里就踩过——Node 的 GET /api/series 是"我的专栏"（要登录），Java 的同一条是公开合集架，
// 路径同名、语义不同，切了就把书房管理器打成 200 空列表，且不会有任何报错。
// 对拍测不出这类差异（对拍只比"两边都有的路由"），所以单独一道：
// 逐个 URL 模式核对方法集合，凡是"Node 有、Java 没有"的，整个前缀都不许切；
// 机器算不出来的"同方法不同义"由人写进 SEMANTIC_CLASHES，让它挡住前缀而不是被人忘掉。
//
//   node scripts/route-inventory.mjs            列清单 + 给出可安全切流的前缀
//   node scripts/route-inventory.mjs --json     机器可读输出
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const JSON_ONLY = process.argv.includes("--json");

/** Node App Router：app/api/articles/[slug]/route.ts → /api/articles/:slug */
function nodeRoutes() {
  const out = new Map();
  const base = path.join(root, "app", "api");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "route.ts" && entry.name !== "route.tsx") continue;
      const rel = path.relative(base, full).split(path.sep).slice(0, -1);
      const url = "/api" + rel.map((s) => (s.startsWith("[") ? "/:seg" : `/${s}`)).join("");
      const src = fs.readFileSync(full, "utf8");
      const methods = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)]
        .map((m) => m[1]);
      out.set(url, new Set(methods));
    }
  };
  walk(base);
  return out;
}

/** Spring：类上 @RequestMapping 前缀 + 方法上 @GetMapping("/x")。变量名 {slug} 归一成 :seg。 */
function javaRoutes() {
  const out = new Map();
  const dir = path.join(root, "server", "src", "main", "java");
  const ANNO = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE" };
  const add = (url, method) => {
    const key = normalize(url);
    out.set(key, new Set([...(out.get(key) ?? []), method]));
  };
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".java")) continue;
      const src = fs.readFileSync(full, "utf8");
      if (!/@RestController/.test(src)) continue;
      const cls = (src.match(/@RequestMapping\(\s*(?:value\s*=\s*)?"([^"]*)"/) ?? [])[1] ?? "";
      // 三种写法都要认：@GetMapping、@GetMapping("/x")、@GetMapping({ "/x", "/y" })
      for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping\b(?:\s*\(([^)]*)\))?/g)) {
        const method = ANNO[m[1]];
        const sub = (m[2] ?? "").match(/"([^"]*)"/)?.[1] ?? "";
        add(`${cls}${sub}`, method);
      }
    }
  };
  walk(dir);
  return out;
}

/** [slug] / {slug} / :slug 三种写法统一成 :seg，路径段名不参与比较。 */
function normalize(url) {
  const cleaned = url.replace(/\{[^}]*\}/g, ":seg").replace(/:[A-Za-z0-9_]+/g, ":seg");
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

const node = nodeRoutes();
const java = javaRoutes();

/**
 * Java 常把一个路径段声明成 `{provider}` 而 Node 用目录名写死（app/api/auth/github、
 * app/api/auth/gitee…）。归一之后 `/api/auth/:seg` 与 `/api/auth/github` 两个键永不相等，
 * 于是已迁完的 OAuth 会被这清单报成缺口——反过来更危险：真实冲突也可能被藏起来。
 * 所以查找前先做一次"字面段 ↔ 通配段"的匹配解析。
 */
const javaWild = [...java.keys()].filter((k) => k.includes(":seg"));
function javaKeyFor(key) {
  if (java.has(key)) return key;
  const segs = key.split("/");
  return javaWild.find((w) => {
    const ws = w.split("/");
    return ws.length === segs.length
      && ws.every((s, i) => s === ":seg" || s === segs[i]);
  }) ?? key;
}
const javaMethods = (key) => java.get(javaKeyFor(key)) ?? new Set();

const nodeKeys = [...node.keys()].map(normalize);
const javaKeys = new Set(java.keys());
// 两栈都挂了端点的 URL 模式：方法集合齐了也不代表语义相同，对拍只覆盖这一批
const overlap = [...javaKeys].filter((k) => nodeKeys.includes(k)).sort();

// 每个 Node 路由：Java 侧同 URL 是否有同名方法
const missing = [];
for (const [url, methods] of node) {
  const key = normalize(url);
  const have = javaMethods(key);
  for (const m of methods) {
    if (!have.has(m)) missing.push({ key, method: m });
  }
}
// Java 独有的端点（为 RSC 新增的聚合接口）——不阻碍切流，只是对拍覆盖不到
const javaOnly = [...java.keys()].filter((k) => !nodeKeys.includes(k));

// 同一 URL 两栈都有、但方法集合不同 → 该前缀切过去会改变行为
const divergent = [];
for (const [url, methods] of node) {
  const key = javaKeyFor(normalize(url));
  if (!javaKeys.has(key)) continue;
  const have = java.get(key);
  const onlyNode = [...methods].filter((m) => !have.has(m));
  const onlyJava = [...have].filter((m) => !methods.has(m));
  if (onlyNode.length || onlyJava.length) divergent.push({ key, onlyNode, onlyJava });
}

/**
 * 已知"同 URL 同方法、语义却不同"的冲突登记。
 *
 * <p>方法集合齐了不等于可以切：两边都能接这个请求，不代表回的是同一件事。这种差别机器算不出来，
 * 一旦被算成"可整体切流"，切过去就是把某个界面悄悄变成一份看着正常的错误数据且不报错。
 * 所以这类点必须由人写在这里，清单负责让它**挡住前缀**而不是被人忘掉。
 *
 * <p>当前为空。第一条登记的是 {@code GET /api/series}（Node=我的专栏 / Java=公开合集架），
 * 解法是把两件事拆成两条 URL：Node 的 GET 对齐成公开架、另开 {@code GET /api/series/mine}，
 * 前端改读新 URL，两栈同语义之后整前缀才切——过程写在闸门 6 与闸门 10 的断言里。
 * 登记着的时候它挡住过一次误切，这条机制就算回本了；清空不等于它可以被删掉。
 */
const SEMANTIC_CLASHES = [];

/** 可安全切流的前缀：该前缀下所有 Node 路由的每个方法都在 Java 里存在。 */
function safePrefixes() {
  const byPrefix = new Map();
  for (const [url, methods] of node) {
    const key = normalize(url);
    const segs = key.split("/").filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const prefix = `/${segs.slice(0, i).join("/")}`;
      if (!prefix.startsWith("/api")) continue;
      const list = byPrefix.get(prefix) ?? [];
      list.push({ key, methods: [...methods] });
      byPrefix.set(prefix, list);
    }
  }
  const safe = [];
  for (const [prefix, routes] of byPrefix) {
    const blocked = routes.flatMap((r) => r.methods
      .filter((m) => !javaMethods(r.key).has(m))
      .map((m) => `${m} ${r.key}`));
    // 语义冲突按"URL 命中或位于该前缀之下"判：切 /api/series 当然会把 GET /api/series 一起带走
    const clash = SEMANTIC_CLASHES.find((c) => prefix === c || prefix.startsWith(`${c}/`)
      || routes.some((r) => r.key === c));
    if (!blocked.length && !clash) safe.push({ prefix, count: routes.length });
  }
  return safe.sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

/** 逐条已被 Java 完整覆盖的 URL 模式：这些可以直接按段通配写进 JAVA_ROUTES。 */
const covered = [...node.entries()]
  .filter(([url, methods]) => [...methods].every((m) => javaMethods(normalize(url)).has(m)))
  .map(([url, methods]) => ({ url: normalize(url), methods: [...methods] }))
  .sort((a, b) => a.url.localeCompare(b.url));

const safe = safePrefixes();
const longest = [];
for (const entry of safe) {
  if (!longest.some((x) => entry.prefix.startsWith(`${x.prefix}/`) || entry.prefix === x.prefix)) longest.push(entry);
}

if (JSON_ONLY) {
  console.log(JSON.stringify({
    node: Object.fromEntries([...node].map(([k, v]) => [normalize(k), [...v]])),
    java: Object.fromEntries(java),
    missing,
    javaOnly,
    divergent,
    overlap,
    covered,
    safePrefixes: longest.map((x) => x.prefix),
  }, null, 2));
} else {
  console.log(`Node 路由 ${node.size} 个 URL 模式，Java 端点 ${java.size} 个`);
  console.log(`\n【Node 有、Java 没有】${missing.length} 条 —— 这些所在前缀不能整体切流：`);
  for (const m of missing.sort((a, b) => a.key.localeCompare(b.key))) console.log(`   ${m.method.padEnd(6)} ${m.key}`);
  console.log(`\n【同 URL 方法集合不同】${divergent.length} 处 —— 切过去会静默改变行为：`);
  for (const d of divergent) {
    console.log(`   ${d.key}  仅 Node: [${d.onlyNode.join(",")}]  仅 Java: [${d.onlyJava.join(",")}]`);
  }
  console.log(`\n【Java 独有】${javaOnly.length} 条（为 RSC 新增的聚合端点，Node 无对位，不参与对拍）：`);
  for (const k of javaOnly.sort()) console.log(`   ${k}`);
  console.log(`\n【两栈同 URL】${overlap.length} 条 —— 方法齐了不等于语义相同，`
    + `逐条过 scripts/parity.mjs 才算等价（曾经咬过人的是 GET /api/series：Node 回"我的专栏"、`
    + `Java 回公开合集架，同 URL 同方法却不同义，机器算不出来）：`);
  for (const k of overlap) console.log(`   ${k}`);
  console.log(`\n【已被 Java 完整覆盖的 URL 模式】${covered.length} 条 —— 这些可逐条写进 JAVA_ROUTES：`);
  for (const c of covered) console.log(`   ${c.methods.join(",").padEnd(12)} ${c.url}`);
  console.log(`\n【当前可安全整体切流的最长前缀】`);
  for (const s of longest) console.log(`   ${s.prefix.padEnd(34)} 覆盖 ${s.count} 个 URL 模式`);
  const held = SEMANTIC_CLASHES.filter((c) => nodeKeys.includes(c));
  if (held.length) {
    console.log(`   （另有 ${held.length} 处已登记的"同 URL 同方法但语义不同"，其所在前缀已被扣住：${held.join("、")}）`);
  }
  console.log(`\n判定：${missing.length ? "存在缺口 → 上面未列出的前缀一律不要整体切（可用段通配逐条切）" : "无缺口"}；`
    + `清单由本脚本现算，改完任一侧路由都要重跑一次再决定切流范围。`);
}
// 这是清单不是判分：缺口数量是 P5/P6/P7 的进度条，退出码恒 0，
// 免得在迁移完成前每次跑都红，反而没人看。
process.exit(0);
