#!/usr/bin/env node
// 闸门 16：建库。P7 要把 Node 侧的 SQL 删干净，而"谁来建库"必须先有答案——
// 双轨期建库是 Node 顺手做的（lib/data.ts 里那批 ensure* 在第一次用到时把表建出来），
// 删掉它的第一天，一份新库就会谁都建不起来。
//
// 这一道测的不是"SQL 写对了没"，而是**进程**：闸门自己启一个 Java 实例，把数据源指向空库，
// 等它应答，再比结构。因为"脚本看着对"和"启动时真的会跑、跑完还能服务"之间隔着
// 打包有没有把 schema 带进 classpath、Bean 初始化顺序、幂等与否——这些都没法靠读代码确认。
//
//   node scripts/schema-check.mjs
//
// 前提：
//   ① .env 的 DATABASE_URL 指向克隆库 inkstack_j。本闸门只在三个临时库里写
//      （inkstack_boot_a/b/c），跑完自己 DROP；参照库只读未动。
//   ② server/target/classes 是最新编译产物（闸门会自己检查 schema.sql 是否比 classpath 新）。
//   ③ 需要 CREATE DATABASE 权限；没有就整道判 SKIP，而不是假装绿。
//   ④ 端口 3198 空着（闸门自己起的实例用）。
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
  .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const url = new URL(env.DATABASE_URL);
const DB_USER = decodeURIComponent(url.username);
const DB_PASS = decodeURIComponent(url.password);
const HOST = url.hostname;
const PORT = Number(url.port || 3306);
const REF = url.pathname.slice(1);              // inkstack_j：应用真跑出来的形状，只读
const A = "inkstack_boot_a";                    // Java 建的库
const B = "inkstack_boot_b";                    // 对照：手工应用 db/schema.sql
const C = "inkstack_boot_c";                    // 建库开关关掉时应一无所成
const JAVA_PORT = Number(process.env.SCHEMA_JAVA_PORT || 3198);
const MVN = process.env.MVN || "D:/maven/apache-maven-3.8.2/bin/mvn";
const BASH = process.env.BASH || "D:/Git/bin/bash.exe";

/**
 * 挑一个能用的 JDK。
 *
 * <p>不能直接沿用环境变量里的 JAVA_HOME：这台机器的默认值是 JDK 8（工程里到处要用 Corretto 17），
 * 而 mvn 在 8 上跑 spring-boot:run 只会回一句 PluginContainerException——闸门看起来是"建库失败"，
 * 其实是构建工具起不来。所以这里真的跑一次 `java -version` 判主版本，选不出来就 SKIP，
 * 不把环境问题报成代码问题。
 */
function pickJavaHome() {
  const candidates = [process.env.SCHEMA_JAVA_HOME, process.env.JAVA_HOME,
    "C:/Users/AMBITIOUS_YUAN/.jdks/corretto-17.0.11"].filter(Boolean);
  const why = [];
  for (const home of candidates) {
    try {
      const out = execSync(`"${posix(home)}/bin/java" -version 2>&1`, { encoding: "utf8" });
      const major = Number((out.match(/version .(\d+)/) ?? [])[1] || 0);
      if (major >= 17) return { home, major };
      why.push(`${home} 是 ${major}`);
    } catch (probeFailed) {
      why.push(`${home} 跑不动（${String(probeFailed.message).slice(0, 40)}）`);
    }
  }
  return { why: why.join("；") };
}
const jdk = pickJavaHome();
const JAVA_HOME = jdk.home ?? "";

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (label, detail = "") => { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, detail) => { fail++; console.log(`FAIL  ${label}  — ${detail}`); };
const skipped = (label, detail) => { skip++; console.log(`SKIP  ${label}  — ${detail}`); };
const check = (cond, label, detail) => {
  const text = typeof detail === "function" ? detail() : detail;
  if (cond) ok(label, text); else bad(label, text || "（无细节）");
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function posix(p) { return p.replace(/\\/g, "/"); }

const mysql = createRequire(import.meta.url)("mysql2/promise");
const jdbc = (db) => `jdbc:mysql://${HOST}:${PORT}/${db}`
  + "?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia%2FShanghai&useSSL=false"
  + "&allowPublicKeyRetrieval=true&useAffectedRows=true";
const admin = await mysql.createConnection({ host: HOST, port: PORT, user: DB_USER, password: DB_PASS });
const into = (db) => mysql.createConnection({
  host: HOST, port: PORT, user: DB_USER, password: DB_PASS, database: db, multipleStatements: true,
});

/** 谁占着这个端口：mvn fork 出来的 JVM 才是持有者，杀它才有用。 */
function pidOnPort(port) {
  try {
    const line = execSync("netstat -ano -p tcp", { encoding: "utf8" })
      .split(/\r?\n/).find((l) => l.includes(`:${port} `) && /LISTENING/i.test(l));
    return line ? Number(line.trim().split(/\s+/).pop()) : 0;
  } catch {
    return 0;
  }
}

/**
 * 起一个只为建库存在的 Java 实例。
 *
 * <p>走 bash 而不是直接 spawn：Windows 下 {@code mvn} 是 shell 脚本，{@code spawn(shell:false)}
 * 会 EINVAL；而 {@code cmd} 会把数据源 URL 里的 {@code &} 当命令分隔符吃掉。
 * 停也必须按端口停——杀 mvn 不带走它 fork 的 JVM，端口一占着下一轮就起不来。
 */
function startJava(db, { auto = true } = {}) {
  const runArgs = [`--server.port=${JAVA_PORT}`, `--INKSTACK_DB_URL=${jdbc(db)}`,
    `--INKSTACK_DB_USER=${DB_USER}`, `--INKSTACK_DB_PASSWORD=${DB_PASS}`,
    // 双轨期这台实例只为建库存在：分身不打上游、不烧真 Key，唯一要看的动作是建表
    "--inkstack.agent.service-url=", "--inkstack.agent.deepseek-key=",
    `--inkstack.schema.auto=${auto ? "true" : "false"}`].join(" ");
  const cmd = `cd '${posix(path.join(root, "server"))}' && JAVA_HOME='${posix(JAVA_HOME)}' `
    + `'${posix(MVN)}' -o -q -s settings.xml spring-boot:run `
    + `-Dspring-boot.run.arguments='${runArgs}'`;
  const proc = spawn(BASH, ["-lc", cmd], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (b) => { log += b.toString(); });
  proc.stderr.on("data", (b) => { log += b.toString(); });
  return {
    get log() { return log; },
    async stop() {
      const pid = pidOnPort(JAVA_PORT);
      if (pid) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); } catch { /* 已退 */ }
      }
      try { proc.kill("SIGKILL"); } catch { /* 已退 */ }
      for (let i = 0; i < 15 && pidOnPort(JAVA_PORT); i++) await sleep(1000);
    },
  };
}

/** 等应用真的开始应答（不是"端口开了"，是真的能回一个 HTTP 状态）。 */
async function waitAnswering() {
  for (let i = 0; i < 75; i++) {
    try {
      const res = await fetch(`http://localhost:${JAVA_PORT}/api/articles`);
      return { responded: true, status: res.status, text: await res.text() };
    } catch { /* 还没起来 */ }
    await sleep(2000);
  }
  return { responded: false, status: 0, text: "" };
}

const snap = async (db) => {
  const conn = await into(db);
  const tables = (await conn.query(
    `SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]))[0]
    .map((r) => r.t);
  const cols = await conn.query(
    `SELECT TABLE_NAME tbl, COLUMN_NAME col, DATA_TYPE ty, IS_NULLABLE nu, COLUMN_DEFAULT df
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db])
    .then((r) => r[0]);
  const idx = await conn.query(
    `SELECT TABLE_NAME tbl, INDEX_NAME name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) c
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME`, [db])
    .then((r) => r[0]);
  const fks = await conn.query(
    `SELECT k.TABLE_NAME tbl, k.CONSTRAINT_NAME name, k.COLUMN_NAME c, k.REFERENCED_TABLE_NAME rt,
            rc.DELETE_RULE rule
       FROM information_schema.REFERENTIAL_CONSTRAINTS rc
       JOIN information_schema.KEY_COLUMN_USAGE k
         ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      WHERE rc.CONSTRAINT_SCHEMA = ?`, [db]).then((r) => r[0]);
  await conn.end();
  return { tables, cols, idx, fks };
};
const colSet = (rows) => new Set(rows.map((r) => `${r.tbl}.${r.col}`));
const idxSet = (rows) => new Set(rows.map((r) => `${r.tbl}/${r.name}(${r.c})`));
// DELETE_RULE 进键：级联与 RESTRICT 在 information_schema 里是"同一条外键"的两种不同东西，
// 只比名字与两端的话，删同一篇文章会一侧成功、一侧 500 而结构比对全绿。
const fkSet = (rows) => new Set(rows.map((r) => `${r.tbl}/${r.name}(${r.c}->${r.rt} ${r.rule})`));
const onlyIn = (a, b) => [...a].filter((v) => !b.has(v));

/* ---------- 现场 ---------- */
/*
 * ## 0 DDL 的归属（静态扫描，不连库、不启进程）
 *
 * 建库这件事的判据不是"跑起来没报错"，而是**只有一个地方写着表结构**。
 * 双轨期最阴的失效方式是：Java 的建库器与 Node 的懒迁移各建各的表，两边都绿，
 * 而它们建出来的东西不一样——于是"新库"取决于第一个敲到那个接口的请求走的是哪栈。
 * 所以这里把话说死：web 层（lib / app / components / middleware）里不许出现一条 DDL，
 * 出现即红。扫描时把注释与模板串里的 SQL 关键字也算进来：真正的坏味道就是
 * "某处藏着一段建表 SQL"，藏在注释里同样要被抓出来（注释里的 DDL 会在下一次改代码时复活）。
 */
const DDL_WORDS = /\b(CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE|DROP\s+TABLE|DROP\s+INDEX|ADD\s+COLUMN|DROP\s+COLUMN|MODIFY\s+COLUMN|RENAME\s+COLUMN|information_schema\.COLUMNS|information_schema\.STATISTICS)\b/i;
const scanRoots = ["lib", "app", "components"];
const offenders = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const text = fs.readFileSync(path.join(root, p), "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (!DDL_WORDS.test(line)) return;
      // 只放过"说明这段 DDL 归谁"的注释行：必须整行是注释、且不含反引号模板串
      const asComment = /^\s*(\/\/|\*|\/\*)/.test(line) && !line.includes("`");
      if (!asComment) offenders.push(`${p}:${i + 1}: ${line.trim().slice(0, 72)}`);
    });
  }
};
for (const d of scanRoots) walk(d);
if (fs.existsSync(path.join(root, "middleware.ts"))) {
  const text = fs.readFileSync(path.join(root, "middleware.ts"), "utf8");
  text.split(/\r?\n/).forEach((line, i) => {
    if (DDL_WORDS.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) offenders.push(`middleware.ts:${i + 1}`);
  });
}
check(offenders.length === 0,
  "## 0 web 层一条 DDL 都没有：表结构只由 db/schema.sql + Java 的 SchemaBootstrap 负责",
  () => offenders.length ? `${offenders.length} 处：\n      ${offenders.slice(0, 8).join("\n      ")}` : "干净");

let ready = true;
if (!jdk.home) {
  skipped("整道闸门", `找不到 JDK 17+（${jdk.why ?? "无候选"}）—— 构建工具起不来不该报成建库失败`);
  ready = false;
}
try {
  for (const db of [A, B, C]) {
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await admin.query(`CREATE DATABASE \`${db}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
} catch (noPriv) {
  ready = false;
  skipped("整道闸门", `建不了临时库（${String(noPriv.message).slice(0, 64)}）：需要 CREATE DATABASE 权限`);
}
if (ready) {
  const src = fs.statSync(path.join(root, "db", "schema.sql")).mtimeMs;
  const inJar = path.join(root, "server", "target", "classes", "db", "schema.sql");
  const copied = fs.existsSync(inJar) ? fs.statSync(inJar).mtimeMs : 0;
  check(copied >= src, "Maven 已把 db/schema.sql 拷进 classpath（Java 读的就是这份，不存在第二套定义）",
    () => `源文件 ${new Date(src).toISOString()} / classpath ${copied ? new Date(copied).toISOString() : "没有"}`);
}

let instance = null;
try {
  if (ready) {
    console.log("## 1 对着一个空库启动");
    console.log(`   （用 ${JAVA_HOME} 起 mvn，JDK 主版本 ${jdk.major}）`);
    instance = startJava(A);
    const up = await waitAnswering();
    check(up.status === 200,
      "空库上 Java 起得来，并且 GET /api/articles 是 200（表不存在的话这里是 500）",
      () => (up.responded ? `HTTP ${up.status} ${up.text.slice(0, 60)}` : `120 秒内没应答：${instance.log.slice(-260)}`));

    console.log("\n## 2 建出来的形状必须等于「Node 那套 DDL 全跑完」的形状");
    const connB = await into(B);
    // schema.sql 顶部带 CREATE DATABASE / USE：整文件直喂会把会话切进主库，先剥掉
    const schemaText = fs.readFileSync(path.join(root, "db", "schema.sql"), "utf8")
      .replace(/CREATE DATABASE[^;]*;/gi, "").replace(/^\s*USE\s+\w+\s*;/gim, "");
    await connB.query(schemaText);
    await connB.end();
    const [whereB] = await (await into(B)).query("SELECT DATABASE() AS db");
    check(whereB[0].db === B,
      "参照库自己也没被 USE 带走（这条同时是给自己立的规矩：程序化应用 schema.sql 必须先剥 USE）",
      () => `会话在 ${whereB[0].db}`);

    const [built, hand, clone] = [await snap(A), await snap(B), await snap(REF)];
    const [ta, tb, tc] = [new Set(built.tables), new Set(hand.tables), new Set(clone.tables)];
    check(ta.size === tb.size && onlyIn(ta, tb).length === 0 && onlyIn(tb, ta).length === 0,
      "Java 建的表集合 == 手工应用 db/schema.sql 的结果（同一份定义、两个执行者）",
      () => `Java ${ta.size} / 手工 ${tb.size}；Java 多 ${onlyIn(ta, tb).join(",") || "无"}、少 ${onlyIn(tb, ta).join(",") || "无"}`);
    check(onlyIn(tc, ta).length === 0,
      "Java 建的库覆盖运行库 inkstack_j 的每一张表（少一张就是删 Node SQL 之后才炸出来的洞）",
      () => `缺：${onlyIn(tc, ta).join(",") || "无"}`);
    const missingCols = onlyIn(colSet(clone.cols), colSet(built.cols));
    const extraCols = onlyIn(colSet(built.cols), colSet(clone.cols));
    check(missingCols.length === 0 && extraCols.length === 0,
      "列集合与运行库逐一对上（comment_likes 与 users 的三个 totp 列从前只活在 Node 的 ensure* 里，"
      + "现在必须由建库自己给）",
      () => `缺 ${missingCols.length}：${missingCols.slice(0, 6).join(",")}｜多 ${extraCols.length}：${extraCols.slice(0, 6).join(",")}`);
    const byKey = (rows) => new Map(rows.map((r) => [`${r.tbl}.${r.col}`, r]));
    const [mb, mh] = [byKey(built.cols), byKey(hand.cols)];
    const shapeDiff = [...mb.keys()].filter((k) => mh.has(k)
      && (mb.get(k).ty !== mh.get(k).ty || mb.get(k).nu !== mh.get(k).nu));
    check(shapeDiff.length === 0,
      "同名列的类型与可空性与手工应用一致（不是「看着差不多」，是 information_schema 里一致）",
      () => shapeDiff.slice(0, 5).map((k) => `${k}:${mb.get(k).ty}/${mh.get(k).ty}`).join(" ") || "一致");
    const defaultDiff = [...mb.keys()].filter((k) => mh.has(k)
      && String(mb.get(k).df) !== String(mh.get(k).df));
    check(defaultDiff.length === 0,
      "默认值也一致：DEFAULT 0 / DEFAULT '' / CURRENT_TIMESTAMP 差一个，「这行算不算已扣墨」就可能两栈不同",
      () => defaultDiff.slice(0, 5).map((k) => `${k}:${mb.get(k).df}vs${mh.get(k).df}`).join(" ") || "一致");
    const [ia, ih] = [idxSet(built.idx), idxSet(hand.idx)];
    check(ia.size === ih.size && onlyIn(ih, ia).length === 0,
      "索引一条不少（FULLTEXT ngram 少了不报错，只会让 RAG 与搜索静默降级成「查不到」）",
      () => `Java ${ia.size} / 手工 ${ih.size}｜缺 ${onlyIn(ih, ia).slice(0, 4).join(",") || "无"}`);
    check(onlyIn(fkSet(hand.fks), fkSet(built.fks)).length === 0,
      "外键一条不少（级联姿势不一致的话，删同一篇文章两栈会一个成功一个 500）",
      () => onlyIn(fkSet(hand.fks), fkSet(built.fks)).slice(0, 4).join(",") || "齐");

    /*
     * 下面两行是「P7c 可以删 Node 懒迁移」的正面依据。
     * 前面那些行比的是 Java 与 schema.sql——同一个定义的两个执行者，对不出"定义本身漏了什么"。
     * 而运行库是被 Node 那批 ensure* 一路改出来的：它身上有、schema.sql 给不出的东西
     * （一条索引、一个级联规则），就是"删掉懒迁移之后新库永远缺的那一块"。
     * 方向必须是 运行库 ⊆ Java 建的库，反过来不要求（库可以比脚本新）。
     */
    const missingIdx = onlyIn(idxSet(clone.idx), ia);
    check(missingIdx.length === 0,
      "运行库的每一条索引都在 Java 建的库里（P7c 删 Node 懒迁移的前提：懒迁移建过的索引已在 schema.sql）",
      () => `缺 ${missingIdx.length}：${missingIdx.slice(0, 5).join(" ") || "无"}`);
    const missingFks = onlyIn(fkSet(clone.fks), fkSet(built.fks));
    check(missingFks.length === 0,
      "运行库的每一条外键连级联规则都在 Java 建的库里（少了不报错，只会在删父行时静默留孤儿子行）",
      () => `缺 ${missingFks.length}：${missingFks.slice(0, 5).join(" ") || "无"}`);

    console.log("\n## 3 建库不越界：不许顺手造演示数据");
    // 表可能在上一节就已经暴露出没建出来；这里不能因为 SELECT 抛异常把整个闸门带崩，
    // 所以先查 information_schema 再数行——缺表时给 -1，让这一项自己判红。
    const connA = await into(A);
    const rowCount = async (tbl) => {
      const exists = Number((await connA.query(
        `SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [A, tbl]
      ))[0][0].n) > 0;
      if (!exists) return -1;
      return Number((await connA.query(`SELECT COUNT(*) n FROM \`${tbl}\``))[0][0].n);
    };
    const [usersN, artN] = [await rowCount("users"), await rowCount("articles")];
    await connA.end();
    check(usersN === 0 && artN === 0,
      "新库里 0 用户 0 文章：schema.sql 那两条演示 INSERT 归 scripts/seed.mjs，不归每次启动",
      () => `users=${usersN} articles=${artN}（-1 表示表根本没建出来）`);
    await instance.stop();
    instance = null;

    console.log("\n## 4 幂等：第二次启动不该动坏任何东西");
    const before = await snap(A);
    instance = startJava(A);
    const up2 = await waitAnswering();
    check(up2.status === 200,
      "同一个库上再起一次仍然正常应答（建表语句撞上「已存在」不能把进程拖死）",
      () => (up2.responded ? `HTTP ${up2.status}` : `没起来：${instance.log.slice(-260)}`));
    const after = await snap(A);
    check(after.tables.length === before.tables.length
      && colSet(after.cols).size === colSet(before.cols).size
      && idxSet(after.idx).size === idxSet(before.idx).size,
      "重启之后表/列/索引一个没变（幂等，不是先删再建）",
      () => `表 ${before.tables.length}→${after.tables.length} 列 ${colSet(before.cols).size}→${colSet(after.cols).size} 索引 ${idxSet(before.idx).size}→${idxSet(after.idx).size}`);
    await instance.stop();
    instance = null;

    console.log("\n## 5 开关：关掉建库时应当什么都不做");
    instance = startJava(C, { auto: false });
    const up3 = await waitAnswering();
    const afterC = await snap(C);
    check(afterC.tables.length === 0,
      "auto=false 时一张表都不建（权限收紧的 DB 用户靠这个开关活着，而不是靠启动失败）",
      () => `表数=${afterC.tables.length}`);
    check(up3.responded && up3.status !== 200,
      "关掉开关对着空库起进程，接口确实应不上（说明上一节那个 200 真的是建库建的，不是别的什么顺手建的）",
      () => `HTTP ${up3.status}`);
    await instance.stop();
    instance = null;

    for (const db of [A, B, C]) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
    console.log(`\n已清场：临时库 ${A} / ${B} / ${C} 全部 DROP，参照库 ${REF} 只读未动`);
  }
} finally {
  if (instance) await instance.stop();
  for (const db of [A, B, C]) {
    try { await admin.query(`DROP DATABASE IF EXISTS \`${db}\``); } catch { /* 已删 */ }
  }
  await admin.end();
}

console.log(`\n合计 ${pass + fail} 项（SKIP ${skip}），失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
