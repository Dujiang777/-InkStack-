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
// 这一道自己也窄过一次，而且是**同一类错**（P7f-2 开工前的复核抓出来的）：
// 第一版的判据是"lib/data.ts 里被页面取走的导出函数会不会走到 MySQL"，于是它天生看不见两类东西——
// 页面文件**自己**写的 SQL，以及页面经由 lib/auth.ts、lib/points.ts 这些**别的模块**摸到的库。
// 实况就是：登记表"清零"那天，四个 page.tsx 里还躺着若干句 pool.query，
// 而每个页面都要走的会话解析本身就在打库。判据窄了，"清零"只是一句好听的话。
// 现在按一般化模型重算：**渲染层可达集合里任何直接执行 SQL 的函数**都算，
// 不管它住在哪个文件、不管它是从 data.ts 进口的还是页面里就地写的。两条规则：
//   · 判据的边界由"它想证明什么"决定，不由"它当初怎么写方便"决定；
//   · 棘轮读到 0 时，先问"我看不见的地方有多大"，再问"还剩几条"。
//
// 这道闸门不判"对不对"，判**有没有悄悄变多**：
//   · 登记表（REGISTERED）之外的新面孔 → 红。往渲染层加一条本地 SQL 是把已经换掉的后端接回来。
//   · 登记表里某条已经没有本地 SQL 了 → 也红，提醒从表里删掉（棘轮只许单向转）。
//   · 清到 0 条那天，"页面只渲染"这句话才第一次可以被机器复验，P7f-2 的删除前提才算成立。
//
// 用 TypeScript 的 AST 而不是正则切正文：第一版按"从函数头切到下一个函数头"取体，
// 于是 listWeekly 因为**下一个函数的文档注释里写着 "先 INSERT 占位、再 FOR UPDATE 扣款"**
// 被判成直连 MySQL——假阳性。注释与字符串都会骗过正则，AST 不会。
//
//   node scripts/page-sql-inventory.mjs            跑判定
//   node scripts/page-sql-inventory.mjs --verbose  看在哪个文件第几行、被哪些渲染入口走到
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");
const root = path.resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");

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

/* ---------- 每个文件从仓库内模块取走了哪些符号（带别名解析） ---------- */

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
        // 默认导入：本地叫什么不重要，对面导出表里的那个名字才叫 default
        if (clause.name) names.push({ local: clause.name.text, remote: "default" });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            names.push({ local: el.name.text, remote: el.propertyName?.text ?? el.name.text });
          }
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) names.push({ local: el.name.text, remote: (el.propertyName ?? el.name).text });
      }
      out.push({ to: target, names });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.get(f));
  return out;
}

/** 本文件的"本地名字 → 对面文件的导出名"绑定表：跨文件调用靠它接上节点。 */
const bindings = new Map();
for (const f of wanted) {
  const table = new Map();
  for (const e of importsOf(f)) for (const n of e.names) table.set(n.local, { file: e.to, name: n.remote });
  bindings.set(f, table);
}

/* ---------- 全部文件的顶层函数节点 ---------- */

const DB_TOUCH = new Set(["getPool", "createConnection", "createPool"]);
const DB_METHOD = new Set(["query", "execute", "getConnection", "beginTransaction", "commit", "rollback"]);
/** MySQL 管道本身不算"页面直读 SQL"：连接池就是它的职责。 */
const PLUMBING = new Set(["lib/db.ts"]);
/** 待删的遗留 HTTP 面，以及只为它服务的那份读 SQL——不属于渲染层。 */
const NOT_RENDER = (f) => f.startsWith("app/api/") || f === "lib/data-legacy.ts";

const nodes = new Map();   // "file#fn" → { file, name, node }
const localFns = new Map(); // file → Set<fn>

function declare(file, name, node) {
  if (!name || node === undefined) return;
  const id = `${file}#${name}`;
  if (!nodes.has(id)) nodes.set(id, { file, name, node });
  if (!localFns.has(file)) localFns.set(file, new Set());
  localFns.get(file).add(name);
}

/**
 * 一个文件可能同时有两个名字指向同一个函数：`export default function Foo()` 在对面
 * 的 import 里叫 `default`（本地别名随调用方），在本文件里叫 `Foo`。
 * 只记本名的话，"页面 → 默认导出的组件 → 组件里的 SQL"这条边会在最后一跳断掉，
 * 而页面组件恰恰清一色是默认导出——所以下面三处都要把 default 这个别名一起钉上。
 */
const deferred = [];       // `export default Foo;` 形式的别名，第二遍再解
for (const file of wanted) {
  if (NOT_RENDER(file) || PLUMBING.has(file)) continue;
  const src = parsed.get(file);
  for (const st of src.statements) {
    if (ts.isFunctionDeclaration(st)) {
      const mods = ts.getModifiers(st) ?? [];
      const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      declare(file, st.name?.text ?? (isDefault ? "default" : null), st);
      if (isDefault && st.name) declare(file, "default", st);
    } else if (ts.isVariableStatement(st)) {
      const isDefault = (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer
          && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          declare(file, d.name.text, d.initializer);
          if (isDefault) declare(file, "default", d.initializer);
        }
      }
    } else if (ts.isExportAssignment(st)) {
      // `export default async (...) => {}`；`export default Foo;` 要看 Foo 的脸，留到第二遍
      if (ts.isArrowFunction(st.expression) || ts.isFunctionExpression(st.expression)) {
        declare(file, st.expression.name?.text ?? "default", st.expression);
      } else if (ts.isIdentifier(st.expression)) {
        deferred.push([file, st.expression.text]);
      }
    }
  }
}
// 第二遍：`export default Foo;` 可能写在 Foo 的声明**之前**，一遍扫就会漏掉 default 这个别名。
for (const [file, name] of deferred) {
  const own = nodes.get(`${file}#${name}`);
  if (own) declare(file, "default", own.node);
}

/** 函数体：① 直接摸库吗 ② 调了本文件哪些函数 ③ 用了哪些从别处导入的函数。 */
function analyze(id) {
  const n = nodes.get(id);
  if (!n) return { direct: false, local: [], imported: [] };
  const own = localFns.get(n.file) ?? new Set();
  const table = bindings.get(n.file) ?? new Map();
  const local = new Set();
  const imported = new Set();
  let direct = false;
  const bind = (text) => {
    if (own.has(text)) local.add(text);
    else if (table.has(text)) imported.add(text);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isIdentifier(e)) {
        if (DB_TOUCH.has(e.text)) direct = true;
        bind(e.text);
      } else if (ts.isPropertyAccessExpression(e) && DB_METHOD.has(e.name.text)) {
        direct = true;
      }
    }
    // JSX：<CommentsSection /> 是一次调用，但不是 CallExpression——漏了它就读不到组件里的 SQL
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag)) bind(tag.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(n.node);
  return {
    direct,
    local: [...local],
    imported: [...imported].map((b) => table.get(b)).filter(Boolean),
  };
}

const cache = new Map();
const fact = (id) => {
  if (!cache.has(id)) cache.set(id, analyze(id));
  return cache.get(id);
};

/**
 * `#default` 与它旁边那个真名是**同一个函数**的别名，不能算成两条。
 * 不钉这一步的话四个运营台页面会各报两遍，"还剩几条"这个数就假的。
 */
const canonOf = new Map();
for (const [id, n] of nodes) {
  const key = `${n.file}@${n.node.pos}`;
  const prev = canonOf.get(key);
  if (!prev || (prev.endsWith("#default") && !id.endsWith("#default"))) canonOf.set(key, id);
}
const canon = (id) => {
  const n = nodes.get(id);
  return n ? (canonOf.get(`${n.file}@${n.node.pos}`) ?? id) : id;
};

/* ---------- 从渲染入口出发走一遍调用闭包 ---------- */

const seeds = wanted.filter((f) => !NOT_RENDER(f)
  && (/(\/|^)page\.tsx$/.test(f) || /(\/|^)layout\.tsx$/.test(f)
    || f === "app/sitemap.ts" || f === "app/feed.xml/route.ts"));

const reached = new Set();     // 渲染层走得到的 "file#fn"
const fromPages = new Map();   // "file#fn" → Set(渲染入口)
const queue = [];

/**
 * 把 seedsFrom 并入 id 的入口集，并且**只要集合变大就重新入队**。
 * 第一版只在"第一次发现"时记归属，于是 report 出来的"被哪些页面走到"其实是
 * 首个发现者——一句话把广度说成了深度。这里是传递闭包，必须迭代到不动点；
 * 每次并入至多新增一个 (节点, 入口) 对，所以一定停得下来。
 */
function offer(id, seedsFrom) {
  let set = fromPages.get(id);
  if (!set) { set = new Set(); fromPages.set(id, set); }
  let grew = false;
  for (const s of seedsFrom) if (!set.has(s)) { set.add(s); grew = true; }
  if (grew || !reached.has(id)) { reached.add(id); queue.push(id); }
}
for (const s of seeds) for (const name of localFns.get(s) ?? []) offer(canon(`${s}#${name}`), [s]);
while (queue.length) {
  const id = queue.shift();
  const here = nodes.get(id);
  if (!here) continue;
  const f = fact(id);
  for (const nid of [...f.local.map((l) => `${here.file}#${l}`),
    ...f.imported.map((i) => `${i.file}#${i.name}`)]) {
    if (!nodes.has(nid)) continue;                     // 对端不是函数节点（类型、常量）
    offer(canon(nid), fromPages.get(id));
  }
}
const line = (id) => {
  const n = nodes.get(id);
  return parsed.get(n.file).getLineAndCharacterOfPosition(n.node.getStart()).line + 1;
};
const offenders = [...reached].filter((id) => fact(id).direct).sort();

/**
 * 登记表：今天仍由渲染层在进程内直连 MySQL 的函数，写成 `文件#函数`。
 * 每条都得先给 Java 补一个读端点（或把这件动作整个交给 Java），再从表里摘掉。
 *
 * 这张表在 P7f-1e 那天清过一次零，第二天被判据拓宽到 8——见文件头。
 * P7f-1f-a 摘掉前四条（页面自己写的 SQL，从来没有 HTTP 面），剩下 4 条都住在 lib 里、
 * 被若干页面共用：其中 `getCurrentUser` 是**每个已登录页面**都要走的一次读＋一次节流写，
 * `grantDailyQuota` 更是渲染时直接发生的**发放动作**——它连"读"都不是。
 *
 * 摘名字的顺序也是有讲究的：先把 Java 端点与页面的 remote 调用都落地、再摘，
 * 于是这道闸门在中间那一步一定会红一次（"登记表里某条已经没有本地 SQL"），
 * 那个红就是它在工作——而不是"改坏了"。
 */
const REGISTER = [
  { id: "lib/auth.ts#getCurrentUser", why: "会话解析（签名+库内有效性双保险）+ last_seen 节流写：跨栈最硬的一条，要么 Java 出 /api/me/session，要么 Next 只透传令牌不做判定" },
  { id: "lib/auth.ts#listSessions", why: "安全中心的设备列表：Java 的 GET /api/security/sessions 早就在应答同一份数据，这里只是把 Node 那句 pool.query 换成问它" },
  { id: "lib/link-policy.ts#allowedDomains", why: "外链白名单（渲染时读 link_whitelist）：应改问 Java 的链接策略读端点，或把审核判定整个交给 Java" },
  { id: "lib/points.ts#grantDailyQuota", why: "渲染时发每日 30 滴——这是**写**，不是读：Java 的 /api/auth/me 已经在发同一份额度，等 getCurrentUser 一并过去就能整条摘掉" },
];
const REGISTERED = REGISTER.map((r) => r.id);
const whyOf = (id) => REGISTER.find((r) => r.id === id)?.why ?? "";

const unexpected = offenders.filter((n) => !REGISTERED.includes(n));
const migrated = REGISTERED.filter((n) => !offenders.includes(n));

console.log(`渲染入口 ${seeds.length} 个，可达函数节点 ${reached.size} 个（跨文件，含 JSX 组件引用）`);
console.log(`其中**在渲染层进程内直连 MySQL**的 ${offenders.length} 个`);
for (const id of offenders) {
  const from = [...(fromPages.get(id) ?? [])].sort();
  if (!VERBOSE) { console.log(`  · ${id}`); continue; }
  console.log(`  · ${id.padEnd(44)} :${String(line(id)).padStart(4)}`);
  console.log(`      为什么还在这：${whyOf(id) || "（没写理由——登记表里的每一条都得写）"}`);
  console.log(`      被 ${from.length} 个渲染入口走到：${from.join(" ")}`);
}
if (!VERBOSE && offenders.length) console.log("  （--verbose 看在哪个文件第几行、被哪些页面走到、为什么还没迁）");

let bad = 0;
if (unexpected.length) {
  bad++;
  console.log(`\nFAIL  登记表之外出现了 ${unexpected.length} 个渲染层直连 SQL：${unexpected.join(" ")}`);
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
  console.log("\n✓ 登记表已清空：渲染层（页面 + 它能走到的所有模块）不再有任何进程内 SQL，");
  console.log("  \"页面只渲染、数据全问 Java\" 从此可以被机器复验。");
  console.log("  （app/api/** 与 lib/data-legacy.ts 里那些直连 MySQL 的读是**待删的遗留 HTTP 面**，");
  console.log("    不属于渲染层，由闸门 8 计数、P7f-2 一次删除——这一道刻意不把它们算进来，");
  console.log("    否则\"还剩多少没迁\"会随每条路由的写法抖动。）");
} else if (!bad) {
  console.log(`\n⚠ 退出码 0（实况与登记表一字不差），但渲染层仍在这 ${offenders.length} 条里摸 MySQL：`);
  console.log("  \"web 退化为纯渲染层\" 还没成立，P7f-2 的删除前提因此**不成立**——");
  console.log(`  app/api/** 与 lib/data-legacy.ts 可以删，但这 ${offenders.length} 条得先迁完（P7f-1f），`);
  console.log("  否则删掉遗留 HTTP 面之后，这几处仍然是 Next 进程里的第二个后端。");
}
process.exit(bad ? 1 : 0);
