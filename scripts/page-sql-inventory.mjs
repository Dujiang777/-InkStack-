#!/usr/bin/env node
// 页面直读 SQL 清单（闸门 18）：数清"渲染层还在自己摸 MySQL 的函数"，并把它锁成棘轮。
//
// 为什么要有这一道：P7 的收尾承诺是"web 退化为纯渲染层"——删掉 app/api/** 与那份遗留读 SQL
// 之后，Next 只渲染、数据全问 Java。但"退化到什么程度"这件事原先只写在 README 的一句话里
// （"页面侧只剩一条路：27 个读函数"），而那句话**说过头了**：正文读路径确实只剩 Java，
// 运营台八张表、首页的统计/作者榜/关注流、个人中心的成就、书房的文章名建议却仍然在 Next
// 进程里直连 MySQL。它们根本没有 HTTP 面（Server Component 直调，从来不需要路由），
// 所以对拍、契约基线、路由盘点全都看不见——只有把调用图算出来才看得见。
//
// 这道闸门不判"对不对"，判**有没有悄悄变多**：
//   · 登记表（REGISTERED）之外的新面孔 → 红。往渲染层加一条本地 SQL 是把已经换掉的后端接回来。
//   · 登记表里某条已经没有本地 SQL 了 → 也红，提醒从表里删掉（棘轮只许单向转）。
//   · 清到 0 条的那天，"页面只渲染"这句话才第一次可以被机器复验，P7f-2 的删除前提才算成立。
//
// 用 TypeScript 的 AST 而不是正则切正文：第一版按"从函数头切到下一个函数头"取体，
// 于是 listWeekly 因为**下一个函数的文档注释里写着 "先 INSERT 占位、再 FOR UPDATE 扣款"**
// 被判成直连 MySQL——假阳性。注释与字符串都会骗过正则，AST 不会。
//
//   node scripts/page-sql-inventory.mjs            跑判定
//   node scripts/page-sql-inventory.mjs --verbose  列出每条被哪个页面调、写在哪一行
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");
const root = path.resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");
const DATA = "lib/data.ts";

/* ---------- 收集源文件（app / lib / components / middleware） ---------- */

const wanted = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, r);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) wanted.push(r);
  }
})(root, "");
for (let i = wanted.length - 1; i >= 0; i--) {
  if (!/^(app|lib|components)\//.test(wanted[i])) wanted.splice(i, 1);
}
wanted.push("middleware.ts");
const has = new Set(wanted);

const parsed = new Map();
for (const f of wanted) {
  parsed.set(f, ts.createSourceFile(f, fs.readFileSync(path.join(root, f), "utf8"),
    ts.ScriptTarget.ESNext, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
}

/* ---------- 每个文件从仓库内模块取走了哪些符号 ---------- */

function importsOf(f) {
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specNode = node.moduleSpecifier;
      if (!specNode || !ts.isStringLiteral(specNode)) return;
      let spec = specNode.text;
      if (spec.startsWith("@/")) spec = spec.slice(2);
      else if (spec.startsWith(".")) spec = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      else return;
      const target = [spec, `${spec}.ts`, `${spec}.tsx`, `${spec}/index.ts`].find((c) => has.has(c));
      if (!target) return;
      const names = [];
      const clause = ts.isImportDeclaration(node) ? node.importClause
        : (node.exportClause && ts.isNamespaceExport(node.exportClause) ? undefined : node.exportClause);
      if (clause && ts.isImportClause(clause)) {
        if (clause.name) names.push(clause.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) names.push(el.name.text);
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) names.push((el.propertyName ?? el.name).text);
      }
      out.push({ to: target, names });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.get(f));
  return out;
}

/* ---------- lib/data.ts：顶层函数 + 谁摸了库 ---------- */

const data = parsed.get(DATA);
const fns = new Map();      // 名字 → { node, exported }
for (const st of data.statements) {
  const isExport = !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (ts.isFunctionDeclaration(st) && st.name) fns.set(st.name.text, { node: st, exported: isExport });
  else if (ts.isVariableStatement(st) && isExport) {
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer
        && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
        fns.set(d.name.text, { node: d.initializer, exported: true });
      }
    }
  }
}

const DB_TOUCH = new Set(["getPool", "createConnection", "createPool"]);
const DB_METHOD = new Set(["query", "execute", "getConnection", "beginTransaction", "commit", "rollback"]);

/** 一个函数会不会走到 MySQL：直接调用库 API，或调了本文件里会走的函数。 */
function scan(name, seen = new Set()) {
  const entry = fns.get(name);
  if (!entry || seen.has(name)) return { direct: false, via: null };
  seen.add(name);
  const calls = new Set();
  let direct = false;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isIdentifier(e)) {
        if (DB_TOUCH.has(e.text)) direct = true;
        calls.add(e.text);
      } else if (ts.isPropertyAccessExpression(e) && DB_METHOD.has(e.name.text)) {
        direct = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(entry.node);
  if (direct) return { direct: true, via: null, seen };
  for (const c of calls) {
    if (c === name || !fns.has(c)) continue;
    const sub = scan(c, seen);
    if (sub.direct) return { direct: true, via: c, seen };
  }
  return { direct: false, via: null, seen };
}

/* ---------- 从渲染入口出发，页面侧取走了 data.ts 的哪些名字 ---------- */

const seeds = wanted.filter((f) => /(\/|^)page\.tsx$/.test(f) || /(\/|^)layout\.tsx$/.test(f)
  || f === "app/sitemap.ts" || f === "app/feed.xml/route.ts");
const pulled = new Map();     // data.ts 符号 → Set(渲染入口)
const reachable = new Set(seeds);
const queue = [...seeds];
while (queue.length) {
  const f = queue.shift();
  for (const e of importsOf(f)) {
    if (e.to.startsWith("app/api/")) continue;   // 待删的遗留 HTTP 面，不算渲染层
    if (e.to === DATA) for (const n of e.names) {
      if (!pulled.has(n)) pulled.set(n, new Set());
      pulled.get(n).add(f);
    }
    if (!reachable.has(e.to)) { reachable.add(e.to); queue.push(e.to); }
  }
}

const lineOf = (name) => {
  const e = fns.get(name);
  return e ? data.getLineAndCharacterOfPosition(e.node.getStart()).line + 1 : 0;
};

const pageFns = [...pulled.keys()].filter((n) => fns.get(n)?.exported);
const offenders = pageFns.filter((n) => scan(n).direct).sort();

/**
 * 登记表：今天仍由 Next 进程直连 MySQL 的页面取数函数。
 * 每条写清"谁在调它"，是为了让下一个来清的人知道该给 Java 补哪个读端点，
 * 而不是对着函数名猜。运营台这八条尤其别顺手"改成调 /api/admin/*"——
 * 那个前缀下 Java 只有 POST（写侧），GET 列表从来就没有 HTTP 面。
 *
 * 2026-09-28 P7f-1d：首页统计 / 作者榜 / 关注流 / 成就墙 / 集齐奖励 / 专栏题名建议六条已迁到
 * Java（读端点见 PlatformController 与 MeReadController），从表上删了。剩下的八条全是运营台，
 * 需要新建一批 GET 读端点，单独一步做。
 */
const REGISTERED = [
  "adminInsights", "adminListActions", "adminListArticles", "adminListComments",
  "adminListOrders", "adminListReports", "adminListReview", "adminListUsers",
];

const unexpected = offenders.filter((n) => !REGISTERED.includes(n));
const migrated = REGISTERED.filter((n) => !offenders.includes(n));

console.log(`渲染入口 ${seeds.length} 个，可达文件 ${reachable.size} 个`);
console.log(`lib/data.ts 顶层导出函数 ${[...fns.values()].filter((v) => v.exported).length} 个，`
  + `被页面取走 ${pageFns.length} 个，其中**仍在 Next 进程里直连 MySQL**的 ${offenders.length} 个`);
for (const n of offenders) {
  const from = [...(pulled.get(n) ?? [])].sort();
  const why = scan(n);
  console.log(VERBOSE
    ? `  · ${n.padEnd(22)} ${DATA}:${lineOf(n)}  ← ${from.join(" ")}${why.via ? `  (经由 ${why.via})` : ""}`
    : `  · ${n}`);
}
if (!VERBOSE && offenders.length) console.log("  （--verbose 看每条被哪个页面调、写在哪一行）");

let bad = 0;
if (unexpected.length) {
  bad++;
  console.log(`\nFAIL  登记表之外出现了 ${unexpected.length} 个页面直读 SQL：${unexpected.join(" ")}`);
  console.log("      往渲染层加一条进程内 SQL，等于把已经换掉的后端又接回来一次；");
  console.log("      要加就得显式登记，并说清为什么不能让 Java 答。");
} else {
  console.log(`\nPASS  没有新增：登记表内 ${offenders.length} 条，一条不多`);
}
if (migrated.length) {
  bad++;
  console.log(`FAIL  ${migrated.length} 条已经没有本地 SQL 了，却还挂在登记表上：${migrated.join(" ")}`);
  console.log("      棘轮只许单向转：从 REGISTERED 删掉它们。");
}
if (!bad && !offenders.length) {
  console.log("\n✓ 登记表已清空：web 层不再有任何进程内 SQL，"
    + "\"页面只渲染、数据全问 Java\" 从此可以被机器复验。");
} else if (!bad) {
  console.log(`⚠ 退出码 0（与登记表一致），但离"纯渲染层"还差 ${offenders.length} 条。`);
}
process.exit(bad ? 1 : 0);
