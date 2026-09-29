#!/usr/bin/env node
// 第八道闸门（P7f-2 改版）：读者与渲染层点得到的每一个 /api 请求，必须有人在应答。
//
// 为什么改版——这一段是这道闸门自己的历史，别删：
//   原版算的是**两栈差分**：逐个 URL 模式核对"Node 有的方法 Java 是不是也有"，再算出
//   "当前可以整体写进 JAVA_ROUTES 的最长前缀"。那个问题的前提是"切流还没切完"。
//   P7f-2 把 app/api/** 删掉之后，"Node 有什么"这个集合恒等于空：
//   缺口恒 0、方法集合恒等、可切前缀恒为 /api ——三条判据同时失去宾语。
//   一道任何错误都无法让它红的闸门留着，只会伪装"还在守"。
//   所以把它想证明的那个**从来没变过的命题**留下来，换一条算得出来的判据：
//   **前端与渲染层实际发出的每个 /api URL，Java 侧必须有路由接得住。**
//   "可安全切流前缀"那一整段随之退役——JAVA_ROUTES 这个开关本身也退役了（判据 §3），
//   因为一个已经做不到"留空即回滚"的开关比没有开关更坏：它会让人以为还能回滚。
//
// 三条判据：
//   §1 调用点覆盖（AST 扫 app/**（不含 app/api）、components/**、lib/**，方法未知的按 URL 比）
//   §2 遗留 HTTP 面登记表：app/api 下的 route.ts 必须与登记表逐条相等——
//      多一条 = 往已经拆掉的第二个后端里回填代码；少一条 = 删了没摘登记（棘轮只许显式转）。
//   §3 中间件形状：/api/* 的改写不许再依赖任何路由名单。
//
//   node scripts/route-inventory.mjs            跑判定（退出码 0/1）
//   node scripts/route-inventory.mjs --json     机器可读输出
//
// 用 TypeScript 的 AST 而不是正则：字面量可能藏在 JSX 属性里、模板串的 `${}` 里、
// 也可能藏在被删文件的注释里（闸门 18 就栽过"注释骗过正则"）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");
const root = path.resolve(import.meta.dirname, "..");
const JSON_ONLY = process.argv.includes("--json");

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}  — ${detail || "（无细节）"}`); }
  return !!cond;
}

/* ————————————————— Java 侧路由表 ————————————————— */

/** Spring：类上 @RequestMapping 前缀 + 方法上 @GetMapping("/x")。路径变量 {slug} 归一成 :seg。 */
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
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".java")) continue;
      const src = fs.readFileSync(full, "utf8");
      if (!/@RestController/.test(src)) continue;
      const cls = (src.match(/@RequestMapping\(\s*(?:value\s*=\s*)?"([^"]*)"/) ?? [])[1] ?? "";
      // 三种写法都要认：@GetMapping、@GetMapping("/x")、@GetMapping({ "/x", "/y" })
      for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping\b(?:\s*\(([^)]*)\))?/g)) {
        const sub = (m[2] ?? "").match(/"([^"]*)"/)?.[1] ?? "";
        add(`${cls}${sub}`, ANNO[m[1]]);
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

const java = javaRoutes();
const javaWild = [...java.keys()].filter((k) => k.includes(":seg"));

/**
 * 字面段 ↔ 通配段的匹配解析：Java 常把一个路径段声明成 `{provider}`，
 * 而前端写的是 `/api/auth/github` 这样的字面量——不归一就会把已迁完的 OAuth 报成缺口。
 */
function javaKeyFor(key) {
  if (java.has(key)) return key;
  const segs = key.split("/");
  return javaWild.find((w) => {
    const ws = w.split("/");
    return ws.length === segs.length && ws.every((s, i) => s === ":seg" || s === segs[i]);
  }) ?? null;
}

/* ————————————————— 调用点：从 AST 里收 ————————————————— */

/** 一个 /api 字面量 → URL 模式。模板串的 ${} 一律变成一个 :seg 段，query 与 hash 不参与比较。 */
function urlOfNode(node) {
  let raw = null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) raw = node.text;
  else if (ts.isTemplateExpression(node)) raw = templateToPattern(node.getText());
  if (!raw || !raw.startsWith("/api/")) return null;
  // 只取路径：`/api/drafts?title=:seg` 比的是 /api/drafts 这条路由；
  // 而 robots.ts 里那个当"前缀"用的 "/api/" 不是调用点，砍掉尾斜杠后就不成形态了。
  const pathOnly = raw.split(/[?#]/)[0].replace(/\/+$/, "");
  return /^\/api\/.+/.test(pathOnly) ? normalize(pathOnly) : null;
}

/** 把 `${...}` 换成 :seg。一层嵌套花括号以内都吃得下；真要吃不下就没匹配、判据会响，不会藏。 */
function templateToPattern(text) {
  return text.slice(1, -1).replace(/\$\{[^{}]*\}/g, ":seg")
    .replace(/\$\{[^{}]*\{[^{}]*\}[^{}]*\}/g, ":seg");
}

/** 表达式里是否出现了某个名字的标识符（判断"URL 是形参转手进来的"） */
function mentionsIdentifier(node, name) {
  let found = false;
  const visit = (n) => {
    if (!found && ts.isIdentifier(n) && n.text === name) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function methodOfOptions(opts) {  if (!opts || !ts.isObjectLiteralExpression(opts)) return "GET";
  for (const p of opts.properties) {
    if (!ts.isPropertyAssignment(p) || p.name.getText() !== "method") continue;
    const v = ts.isStringLiteral(p.initializer) ? p.initializer.text.toUpperCase() : "?";
    return v;
  }
  return "GET";
}

/**
 * 收集一个源文件里的 /api 调用点。
 * 四层规则，从"知道方法"到"只知道有这么个 URL"，宁多勿漏：
 *   a) `fetch(字面量, {method})` —— 方法直接读字面量；
 *   b) 本文件里"把参数转手给 fetch"的辅助函数（如 AdminConsole 的 post()、java-source 的 ask()），
 *      调用它时传的字面量按该辅助函数里那份 options 的 method 记；
 *   c) `<a href>` / `action=` / `src=` / `location.href =` —— 浏览器发的一定是 GET；
 *   d) 兜底：以上都没认领、但以 /api/ 开头的字面量，方法记 "?"（只按 URL 比，不许藏）。
 */
function callSitesOf(file) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = new Map();
  const claimed = new Set();
  const remember = (url, method, node) => {
    if (!url) return false;
    const pos = sf.getLineAndCharacterOfPosition(node.getStart());
    const key = `${file}:${pos.line + 1} ${method} ${url}`;
    if (!hits.has(key)) hits.set(key, { file, line: pos.line + 1, url, method });
    return true;
  };

  // —— b) 先找出"转手给 fetch"的本文件函数 ——
  const helpers = new Map(); // name -> method
  const isFetchCall = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression)
    && n.expression.text === "fetch";
  const visitForHelpers = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)) && node.body) {
      const name = ts.isFunctionDeclaration(node) ? node.name?.text
        : (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : null);
      const calls = [];
      const collect = (n) => { if (isFetchCall(n)) calls.push(n); ts.forEachChild(n, collect); };
      if (name && node.body !== sf) collect(node.body);
      for (const call of calls) {
        const arg0 = call.arguments[0];
        if (!arg0) continue;
        const names = node.parameters.map((p) => p.name.getText());
        // 转手有两种：fetch(url, …) 与 fetch(`${base()}${url}`, …)，后者也得认
        const passthrough = ts.isIdentifier(arg0)
          ? names.includes(arg0.text)
          : names.some((n) => mentionsIdentifier(arg0, n));
        if (!passthrough) continue;
        helpers.set(name, methodOfOptions(call.arguments[1]));
        break;
      }
    }
    ts.forEachChild(node, visitForHelpers);
  };
  visitForHelpers(sf);

  const walk = (node) => {
    // a) 直接 fetch
    if (isFetchCall(node)) {
      const url = urlOfNode(node.arguments[0]);
      if (url && remember(url, methodOfOptions(node.arguments[1]), node.arguments[0])) {
        claimed.add(node.arguments[0].getStart());
        return;                                     // 模板的内部不再单独看
      }
    }
    // b) 转手给本文件的 fetch 辅助函数
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && helpers.has(node.expression.text)) {
      for (const a of node.arguments) {
        const url = urlOfNode(a);
        if (url && remember(url, helpers.get(node.expression.text), a)) claimed.add(a.getStart());
      }
    }
    // c) JSX 属性 与 location.href 赋值
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      const init = node.initializer;
      if (["href", "action", "src"].includes(name) && init && ts.isStringLiteral(init)
        && init.text.startsWith("/api/")) {
        const url = normalize(init.text);
        remember(url, "GET", init);
        claimed.add(init.getStart());
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText();
      if (/\bhref$/.test(left)) {
        const url = urlOfNode(node.right);
        if (url) {
          remember(url, "GET", node.right);
          claimed.add(node.right.getStart());
        }
      }
    }
    // 模板串里被 ${} 分走的那几段、以及任何没被上面认领的 /api 字面量 → d)
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && !claimed.has(node.getStart())) {
      const url = urlOfNode(node);
      if (url) remember(url, "?", node);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return [...hits.values()];
}

function listFiles(relDir, out = []) {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) { listFiles(`${relDir}/${entry.name}`, out); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

// app/api/** 不参与：那些文件本身就是"待删的遗留 HTTP 面"（判据 §2 管它们），
// 它们内部的 /api 字面量是 OAuth 的 redirect_uri，不是调用点。
const SCAN = [...listFiles("app"), ...listFiles("components"), ...listFiles("lib")]
  .filter((f) => !f.startsWith("app/api/"));
const sites = SCAN.flatMap(callSitesOf).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

/* ————————————————— §1 调用点覆盖 ————————————————— */

const uncovered = [];
for (const s of sites) {
  const key = javaKeyFor(s.url);
  const methods = key ? [...java.get(key)] : [];
  if (!key) uncovered.push({ ...s, why: "Java 侧没有这条 URL 模式" });
  else if (s.method !== "GET" && s.method !== "?" && !methods.includes(s.method)) {
    uncovered.push({ ...s, why: `Java 侧该 URL 只有 [${methods.join(",")}]，没有 ${s.method}` });
  }
}

/* ————————————————— §2 遗留 HTTP 面登记表 ————————————————— */

/**
 * 这张表在 P7f-2 之前登记着 58 个"仍由 Node 进程应答的 /api 路由文件"。
 * 删除路由与"把这张表清空"必须是**同一个提交**——中间那一步这道闸门会红（"登记表里有文件
 * 已经不存在"），那个红就是它在工作。现在是空表，但它不退役，改守反向：
 * 谁再往 app/api 下建一个 route.ts，就是往已经拆掉的第二个后端里回填代码（闸门 18 同款）。
 * 注意 app/feed.xml/route.ts 与 app/sitemap.ts 不算在内：它们是**页面**（喂给阅读器与
 * 搜索引擎的），取数全部经 lib/data.ts → Java，也不在 /api 前缀下。
 */
const LEGACY_ROUTES = [];
const onDisk = listFiles("app/api").filter((f) => f.endsWith("route.ts")).sort();

/* ————————————————— §3 中间件形状 ————————————————— */

const mw = fs.readFileSync(path.join(root, "middleware.ts"), "utf8");
// 判的是"还读不读这个开关"，不是"文中有没有出现过这个词"——注释里还得留着一段话解释它为什么退役，
// 拿字符串命中当判据会把那段说明也判成违规，那种红只会逼人删掉解释。
const readsJavaRoutes = /process\.env\.JAVA_ROUTES/.test(mw);

/* ————————————————— 输出 ————————————————— */

if (JSON_ONLY) {
  console.log(JSON.stringify({
    java: Object.fromEntries([...java].map(([k, v]) => [k, [...v]])),
    sites, uncovered: uncovered.map((u) => `${u.file}:${u.line} ${u.method} ${u.url}`),
    legacyOnDisk: onDisk, legacyRegister: LEGACY_ROUTES,
    middlewareReadsJavaRoutes: readsJavaRoutes,
  }, null, 2));
  process.exit(0);
}

console.log(`Java 端点 ${java.size} 个 URL 模式；调用点 ${sites.length} 处`
  + `（含方法未知的 ${sites.filter((s) => s.method === "?").length} 处，那些只按 URL 比）`);

const missing = uncovered.length === 0;
check(missing, "前端与渲染层点得到的每个 /api URL，Java 侧都有路由接得住",
  missing ? `${sites.length} 处调用点全部命中（URL 模式 + 方法）`
    : uncovered.slice(0, 8).map((u) => `${u.file}:${u.line} ${u.method} ${u.url} — ${u.why}`).join(" | ")
      + (uncovered.length > 8 ? ` | …共 ${uncovered.length} 处` : ""));
const known = [...new Set(sites.map((s) => s.url))].sort();
console.log(`\n【调用点覆盖的 URL 模式】${known.length} 条：`);
for (const k of known) console.log(`   ${k}`);

const newFaces = onDisk.filter((f) => !LEGACY_ROUTES.includes(f));
const gone = LEGACY_ROUTES.filter((f) => !onDisk.includes(f));
check(newFaces.length === 0, "app/api 下不许出现登记表之外的 route.ts",
  newFaces.length ? `新面孔：${newFaces.join(" ")}` : `登记表内 ${LEGACY_ROUTES.length} 条，一条不多`);
check(gone.length === 0, "删掉的遗留路由必须同时从登记表里摘掉（棘轮只许显式转）",
  gone.length ? `已经没有这些文件：${gone.slice(0, 6).join(" ")}${gone.length > 6 ? ` …共 ${gone.length} 条` : ""}`
    : `登记表 ${LEGACY_ROUTES.length} 条与磁盘逐条相等`);

check(!readsJavaRoutes, "middleware 不许再读 process.env.JAVA_ROUTES：/api/* 的改写不依赖任何名单",
  readsJavaRoutes ? "文件里仍然读这个开关（一个做不到「留空即回滚」的开关比没有更坏）"
    : "改写判定与路由名单已无关");

console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
