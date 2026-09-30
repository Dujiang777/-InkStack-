#!/usr/bin/env node
// 摘要列对齐工具：把 `articles` 上那四列计数器按**行集**重算一遍，写回真实值。
//
// 它是"修"的那一条；"判"的那一条是闸门 21（`scripts/counter-check.mjs`）。
// 两者共用 `scripts/counter-exempts.mjs` 里的那一份复算式与豁免登记表——
// 分开各抄一份的话，迟早走成"修的人按 A 口径、判的人按 B 口径"，
// 而这一族缺陷本身的成因就是"一列很多地方读、只有一处该写、却没人写"。
//
// 什么时候要跑它：派生规则**变了**的那一刻。新代码只能让增量守恒（P8b 起 `read_count`
// 第一次有人写），它不会把库里既存的旧账追平：
//   · `read_count` 在换栈前后从来没人写过，种子给过 12840 那样的展示值；
//   · `agent_qa_count` 从 P8a 起才回填，P8a 之前的问答流水全是漏账；
//   · 手动往库里 INSERT 评论/点赞的行（不走接口）也一律对不上。
// 所以上线前值得跑一次：从那一刻起"守恒"这句话才真的对全库成立，之前的账由登记表点名记着。
//
// 边界（这个脚本被允许碰什么，写在代码里而不是README 里）：
//   · 只 UPDATE `articles` 的四列，值 = 行集复算出来的数。**不动行集**
//     （comments / article_likes / read_history / agent_qa 是事实来源，摘要列是抄件；
//     抄件错了改抄件，改抄件的同时去删行是另一回事）。
//   · 默认只读。要写必须明说 `--apply`。
//   · 只允许写在克隆库 `inkstack_j` 上；要写别的库（比如真上线那一次的主库）必须用
//     `--target <库名>` 把那个库名再打一遍。同名两次才肯动手：一条是从连接串里读的，
//     一条是人敲的，两者对不上就说明人并不清楚自己连着哪儿。
//   · 每一条写都是**比较后再写**（`WHERE id = ? AND col = <量到的值>`）。影响行数为 0
//     就说明量与写之间有人在写这一列，整笔回滚而不是覆盖过去——线上在跑的时候误伤的就是
//     刚发生的那一次阅读。
//
// 用法：
//   node scripts/recounters.mjs                          只读：报有哪几处不平
//   node scripts/recounters.mjs --apply                   修登记表外的那些，修完复验
//   node scripts/recounters.mjs --apply --include-exempt  连种子虚构值一起抹平（见下）
//   node scripts/recounters.mjs --target inkstack        只读量主库（写的话要再加 --apply）
//   node scripts/recounters.mjs --emit-registry          把当前不平清单打成 EXEMPT 字面量
//   RECOUNTERS_DB_URL=… node scripts/recounters.mjs       换一条连接串（服务器上的库不叫 inkstack_j）
//
// `--include-exempt` 是产品决定，不是技术决定：那些虚构数字是首屏要用的（"阅读 12,840"
// 比"阅读 3"好看得多，这是演示站）。所以默认**不动**它们，只点名。抹平之后再跑一次
// `--emit-registry`，输出应该是空表，把闸门 21 §8 的登记表换成空表——两件事都要做，
// 只抹数据不改登记表会立刻让那条双向棘轮判红。
//
// 退出码：0 = 没有要对齐的（或已对齐并复验通过）；1 = 还有不平的；2 = 前提不成立（连不上、
// 库名对不上、量与写之间被人写过）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  COLUMNS, EXEMPT, measureDrift, byColumn, registryText, isExempt,
} from "./counter-exempts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

const APPLY = flag("apply");
const WITH_SEEDS = flag("include-exempt");
const EMIT = flag("emit-registry");
const TARGET = opt("target");
const SAFE_DB = "inkstack_j";
// 连接串也可以换一条（对着主库做**只读**测量时用得上，不必改 .env）。
// 它是环境变量而不是命令行参数：库名出现在参数里会让人以为这就选好库了，
// 而真正决定连哪儿的仍然是这一条串——两道闸门（连哪儿、准不准写）要各说各的。
const SOURCE = process.env.RECOUNTERS_DB_URL || env.DATABASE_URL;

const exit = (code, why) => {
  if (why) console.log(`\n${code === 2 ? "中止" : "结论"}：${why}`);
  process.exit(code);
};

// 整段跑在一个 async 包装里：ESM 顶层不许 return，而下面每一段"量完就该收工"的分支
// 都想就地走人。包一层，比把七条分支拧成一条 if/else 链好读。
await (async () => {

/* ---------- 前提：连着的是哪个库，允许不允许写 ---------- */

const mysql = createRequire(import.meta.url)("mysql2/promise");
const url = TARGET ? new URL(SOURCE) : null;
if (url) url.pathname = `/${TARGET}`;
const conn = await mysql.createConnection(url ? url.toString() : SOURCE);
// 库名以服务器答应的为准，不信连接串上写的那个（同一个理由：闸门 21 §0 也不信）
const db = (await conn.query("SELECT DATABASE() AS d"))[0][0].d;
const wanted = TARGET ?? decodeURIComponent(new URL(SOURCE).pathname.slice(1));

console.log(`库 ${db}（--target 说的是 ${wanted}）· 模式 ${APPLY ? "写入" : "只读"}`
  + `${APPLY && WITH_SEEDS ? " + 含种子稿" : ""}`);

if (APPLY) {
  if (db !== SAFE_DB && db !== TARGET) {
    await conn.end();
    return exit(2, `不允许写 ${db}：它不是克隆库 ${SAFE_DB}，也没被 --target ${db} 点名。`
      + `（--target 的值必须与服务器答应的库名一致，两处同名才动手）`);
  }
  if (db !== SAFE_DB) {
    console.log(`⚠ 正在写 ${db}：这是**数据修复**，不是修完还能靠闸门兜住的那种。`);
    console.log(`  跑之前先把这一列的旧值留档：SELECT id, slug, ${COLUMNS.map((c) => c.col).join(", ")} FROM articles;`);
  }
}

/* ---------- 量 ---------- */

const { articles: total, drift } = await measureDrift(conn);
const byCol = byColumn(drift);
const fixable = drift.filter((d) => WITH_SEEDS || !isExempt(d.slug, d.col));
const kept = drift.filter((d) => !fixable.includes(d));

const line = (d) => `${d.slug}.${d.col}：stored=${d.stored} → real=${d.real}`;
console.log(`\n文章 ${total} 篇，四列逐列复算：不平 ${drift.length} 处`
  + ` {${Object.entries(byCol).map(([k, v]) => `${k}:${v}`).join(", ")}}`);
console.log(`  其中登记在册（种子虚构值 / 历史漏账）${kept.length} 处`);
console.log(`  其中这次要动的 ${fixable.length} 处${WITH_SEEDS ? "（含种子稿）" : "（登记表外）"}`);
for (const d of fixable.slice(0, 30)) console.log(`    - ${line(d)}`);
if (fixable.length > 30) console.log(`    … 另有 ${fixable.length - 30} 处，用 --emit-registry 看全表`);

if (EMIT) {
  console.log("\n--emit-registry：当前**全量**不平清单（可直接替换 EXEMPT 的表体）：");
  console.log(registryText(drift) || "  （空表：四列全库守恒，豁免登记表该清空了）");
  await conn.end();
  return exit(0, `共 ${drift.length} 条。顺序不能反：先改数据、再把登记表换成上面这份；`
    + `只改表不改数据，闸门 21 §8 那条"登记表之外没有任何不一致"会当场红。`);
}

if (!APPLY) {
  await conn.end();
  return exit(fixable.length ? 1 : 0, fixable.length
    ? `有 ${fixable.length} 处不平，没动数据（只读模式）。要修：加 --apply。`
    : `登记表外全守恒${kept.length ? `（另有 ${kept.length} 处种子虚构值按口径保留）` : ""}。`);
}

/* ---------- 修：比较后再写，任何一处对不上就整笔回滚 ---------- */

if (!fixable.length) {
  await conn.end();
  return exit(0, "没有要写的，直接收工。");
}

const COLS = new Set(COLUMNS.map((c) => c.col));
let written = 0;
await conn.beginTransaction();
try {
  for (const d of fixable) {
    if (!COLS.has(d.col)) throw new Error(`列名 ${d.col} 不在白名单里，中止`);
    const [r] = await conn.query(
      `UPDATE articles SET ${d.col} = ? WHERE id = ? AND ${d.col} = ?`, [d.real, d.id, d.stored]);
    if (r.affectedRows !== 1) {
      // 行还在但值变了 = 有人在我们量完之后写了这一列。回滚，不覆盖那一次。
      throw new Error(`${line(d)} 写入前已被改动（影响行数 ${r.affectedRows}），整笔回滚`);
    }
    written++;
  }
  // 同一事务里再量一遍：这次量到的应当与写回去的值同源，能挡住"复算式自己算错"
  const again = await measureDrift(conn);
  const left = again.drift.filter((x) => WITH_SEEDS || !isExempt(x.slug, x.col));
  if (left.length) throw new Error(`写完仍不平 ${left.length} 处（第一处：${line(left[0])}），回滚`);
  await conn.commit();
} catch (e) {
  await conn.rollback();
  await conn.end();
  return exit(2, `回滚，一条都没留下：${e.message}`);
}

/* ---------- 复验：换一个读视图再量一次，只看这一族列 ---------- */

const after = await measureDrift(conn);
const afterLeft = after.drift.filter((x) => WITH_SEEDS || !isExempt(x.slug, x.col));
await conn.end();
console.log(`\n提交 ${written} 处，写后复算：不平 ${after.drift.length} 处`
  + `（登记表外 ${afterLeft.length} 处）`);
return exit(afterLeft.length ? 1 : 0, afterLeft.length
  ? "提交之后又出现新的不平——说明线上此刻正在写这一族列，而新写的这些**应当自己守恒**，"
    + "不平的成因要往'还有一条没被 P8b 那几条写路径覆盖的入口'上找。"
  : `全库四列在${WITH_SEEDS ? "含种子稿的" : "登记表外的"}口径下守恒了。`
    + `${EXEMPT.length && !WITH_SEEDS ? ` 闸门 21 §8 现在应当仍是绿的（豁免表 ${EXEMPT.length} 条没被牵连）。` : ""}`);

})();
