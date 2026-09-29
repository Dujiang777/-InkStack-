#!/usr/bin/env node
// 第十七道闸门：登录失败计数必须只有一本账（MySQL 的 rate_hits），哪个入口来的都记在这本上。
//
// 为什么不能只做对拍：限流的行为是"第 6 次要拒绝"，而对拍比的是"两侧应答是否一致"。
// 双轨期两栈各算各的，同一 IP 在 Node 记 5 次、在 Java 也记 5 次，两边都觉得自己没锁，
// 于是第 11 次仍然放行——单看任何一栈的日志都完全正常。这类改动只能靠**换个入口接着记**
// 的断言来验：一个入口记的数，另一个入口必须立刻看得见；一个入口清零，另一个跟着解锁。
//
// 这里的"两个入口"自 P7f-2 起指的是 **经 Next middleware 代理** 与 **直连 Java**，
// 不再是两套实现（脚本开跑先自证这两发都由 Java 应答）。命题从来没变——"计数只有一条路径"——
// 变的是它的反例还能不能存在：双轨期"各记一本"是真实风险，现在它只剩"有人往进程里塞回一个
// 内存桶"这一种走法，而 §⑤ 就是钉这一种的。
//
// 顺带钉住两件相邻的事：窗口的时钟是 MySQL 的 NOW(3)（两台机器的钟可以漂移，只有同一个源
// 才会算出同一个 Retry-After）；以及边缘闸（120 次/分/IP）**故意**留在进程内存里——
// 它每个请求都要过一次，搬进库就把 DoS 刹车变成了 DoS 放大器。
//
//   node scripts/rate-limit-check.mjs
//
// 前提：两个入口都在跑（脚本会自证，探到"其中一个由别的实现应答"就拒绝跑——那说明有人在
// 往回补第二套实现，这一跑比的东西就变了）。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
// 地址优先级：shell 环境变量 > .env > 默认。写反了会出现"以为在打临时实例、其实在打真库"。
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";

// 三个互不相干的假 IP：XFF 首跳就是限流键的一部分（TRUST_PROXY 未设），
// 各段用例各用一个，重跑时不会互相污染，也不会撞上 middleware 的 120 次/分/IP 边缘闸。
const LOGIN_IP = "203.0.113.77";
const SEND_IP = "203.0.113.78";
const OK_EMAIL = (env.INK_TEST_EMAIL || "").trim().toLowerCase();
const OK_PW = env.INK_TEST_PASSWORD || "";
const PROBE_EMAIL = `rl-probe-${Date.now()}@inkstack.dev`;

let pass = 0;
let fail = 0;
function ok(label, detail = "") {
  pass++;
  console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
}
function bad(label, detail) {
  fail++;
  console.log(`FAIL  ${label}  — ${detail}`);
}

const mysql = (await import("mysql2/promise")).default;
const conn = await mysql.createConnection(env.DATABASE_URL);
const bucket = (kind, who, ip) => `${kind}:${who}:${ip}`;
const rowCount = async (b) => {
  const [r] = await conn.query("SELECT COUNT(*) AS n FROM rate_hits WHERE bucket = ?", [b]);
  return Number(r[0].n);
};
const wipe = async (b) => conn.query("DELETE FROM rate_hits WHERE bucket = ?", [b]);

/** 从应答里同时取出"谁答的"和剩余次数，用于自证与断言。 */
async function call(base, p, body, ip, ua) {
  const res = await fetch(base + p, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // ip 传空串表示"什么转发头都不带"：两个入口各自的兜底不一样，最后一条用例要的就是这个差别
      ...(ip ? { "x-forwarded-for": ip } : {}),
      // 登录成功若被判定为"新设备"会发提醒邮件——闸门复用该账号已有的 UA，不打真邮件通道
      ...(ua ? { "user-agent": ua } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 非 JSON 由调用方判定 */ }
  return {
    status: res.status,
    json,
    text,
    backend: res.headers.get("x-backend") ?? "",
    retryAfter: res.headers.get("retry-after") ?? "",
    left: (text.match(/还可尝试 (\d+) 次/) ?? [])[1],
  };
}

// —— 前置：表存在 + 两个入口真的由同一个执行者应答（= 账本只有一本）——
const [tbl] = await conn.query("SHOW TABLES LIKE 'rate_hits'");
if (tbl.length === 0) {
  console.error("FAIL  rate_hits 表不存在：限流还没有共享存储。");
  console.error("      起一次 Java 实例让 SchemaBootstrap 建表（db/schema.sql 已有该表定义），再来跑这道闸门。");
  process.exit(1);
}
const live = await Promise.allSettled([fetch(`${NODE}/api/articles?limit=1`), fetch(`${JAVA}/api/articles?limit=1`)]);
if (live.some((r) => r.status === "rejected")) {
  console.error(`FAIL  两个入口没都在跑（node=${NODE} java=${JAVA}），"共用一本账"的断言无从做起`);
  process.exit(1);
}
/* 前置：两个入口都必须由 Java 应答。
 * 这一条在 P7f-2 之前是**反着**判的（要求 node 端口不带 x-backend，带就说明对岸被切走了、
 * "跨栈累计"退化成自己跟自己比）。现在 Node 侧已经没有 /api 实现了，两个端口本来就应该是
 * 同一个执行者——于是原来的红线翻成新的绿线：**两个入口都得带 x-backend**。
 * 翻过来的好处是它仍然会红：要是谁在 Next 里另起一套登录失败计数（进程内 Map），
 * 打 node 端口这一发就会不带 x-backend，或者两侧报出的剩余次数对不上。
 */
const PREFLIGHT_EMAIL = `preflight-${Date.now()}@inkstack.dev`;
const who = await call(NODE, "/api/auth/login", { email: PREFLIGHT_EMAIL, password: "x" }, LOGIN_IP);
const whoJava = await call(JAVA, "/api/auth/login", { email: PREFLIGHT_EMAIL, password: "x" }, LOGIN_IP);
if (who.backend !== "inkstack-java" || whoJava.backend !== "inkstack-java") {
  console.error(`FAIL  两个入口的 /api/auth/login 不是都由 Java 应答（node 端口=${who.backend || "无"} `
    + `java 端口=${whoJava.backend || "无"}）。`);
  console.error("      P7f-2 起 Node 侧已经没有 /api 实现：这一红说明 middleware 的转发没生效，");
  console.error("      或者有人在 Next 里另起了一套后端。两种都让下面这些判据失去前提，先修再跑。");
  process.exit(1);
}
ok("前置：两个入口都由 Java 应答（限流账本只有一本）",
  "node 端口经 middleware 转发、java 端口直连，两边都带 x-backend");
console.log("      注：这道闸门的『两个入口』= 经 Next 代理与直连 Java，不是两套实现。\n");

// ============================================================
// ① 一个入口记的数，另一个入口立刻看得见（max=5，先记再判）
// ============================================================
const LK = bucket("login", PROBE_EMAIL, LOGIN_IP);
await wipe(LK);
const seq = [
  [NODE, "node", 1], [NODE, "node", 2], [JAVA, "java", 3], [NODE, "node", 4], [JAVA, "java", 5],
];
let stepOk = true;
for (const [base, side, i] of seq) {
  const r = await call(base, "/api/auth/login", { email: PROBE_EMAIL, password: "wrong-password" }, LOGIN_IP);
  // 先记再判：第 5 次当场就锁，所以它的应答是"已临时锁定"而不是"还可尝试 0 次"
  const shaped = i < 5 ? r.status === 401 && r.left === String(5 - i) : r.status === 401 && /临时锁定/.test(r.text);
  if (!shaped) {
    bad(`第 ${i} 次失败（${side} 侧）报出正确额度`, `${r.status} 还可尝试=${r.left ?? "无"} 期望 ${i < 5 ? `剩余 ${5 - i} 次` : "已锁定"}：${r.text.slice(0, 90)}`);
    stepOk = false;
  }
  // 两个入口都该由 Java 应答（P7f-2 起恒如此）：这里比的不是"谁答的"，而是"换个入口，
  // 计数会不会各记各的"——只要有一侧把登录失败记进自己进程内的 Map，第 3 次就报不对了。
  if (r.backend !== "inkstack-java") {
    bad(`第 ${i} 次失败（${side} 入口）由 Java 应答`, `x-backend=${r.backend || "无"}`);
    stepOk = false;
  }
}
if (stepOk) ok("五连失败交替打两个入口，剩余次数连续递减",
  "node·node·java·node·java 每次都报出正确的剩余次数（各记各账的话第 3 次起就报错了）");
const afterFive = await rowCount(LK);
if (afterFive === 5) ok("窗口内行数等于失败次数", "计数落在 rate_hits，不再活在任一进程的 Map 里");
else bad("窗口内行数等于失败次数", `rate_hits 里该桶 ${afterFive} 行，应为 5`);

// 第 5 次（在 Java 上）当场就锁，所以第 6 次在 Node 上必须是 429 而不是再来一次 401
const lockedNode = await call(NODE, "/api/auth/login", { email: PROBE_EMAIL, password: "wrong-password" }, LOGIN_IP);
if (lockedNode.status === 429 && lockedNode.retryAfter) ok("Java 记满 5 次后经 Next 入口也拒绝并带 Retry-After",
  `429 Retry-After=${lockedNode.retryAfter}s`);
else bad("Java 记满 5 次后经 Next 入口也拒绝并带 Retry-After", `${lockedNode.status} retry-after=${lockedNode.retryAfter || "无"}：${lockedNode.text.slice(0, 90)}`);

// 锁定中的请求走的是 verdict（只查不记），不该继续往账本里加行
const stillFive = await rowCount(LK);
if (stillFive === 5) ok("锁定中的请求不再累加计数", "verdict 只查不记，否则被锁的人会越锁越久");
else bad("锁定中的请求不再累加计数", `该桶变成 ${stillFive} 行，应仍是 5`);

// Retry-After 由数据库那把钟算出来，两个入口必须给同一个答案
const lockedJava = await call(JAVA, "/api/auth/login", { email: PROBE_EMAIL, password: "wrong-password" }, LOGIN_IP);
const ra = [Number(lockedNode.retryAfter), Number(lockedJava.retryAfter)];
if (lockedJava.status === 429 && Math.abs(ra[0] - ra[1]) <= 3) ok("两个入口报出同一个解锁时间", `node=${ra[0]}s java=${ra[1]}s`);
else bad("两个入口报出同一个解锁时间", `node=${ra[0]}s java=${ra[1]}s（java 状态 ${lockedJava.status}）`);

// ============================================================
// ② 窗口的时钟是 MySQL 的：把行推到窗口外，两个入口必须同时解锁
// ============================================================
await conn.query("UPDATE rate_hits SET ts = DATE_SUB(ts, INTERVAL 960 SECOND) WHERE bucket = ?", [LK]);
const stale = await rowCount(LK);
if (stale === 5) ok("过期行还在表里（等待清扫）", `${stale} 行的 ts 已被推到 16 分钟前`);
else bad("过期行还在表里（等待清扫）", `预期 5 行，实际 ${stale}`);
const reopened = await call(NODE, "/api/auth/login", { email: PROBE_EMAIL, password: "wrong-password" }, LOGIN_IP);
if (reopened.status === 401 && reopened.left === "4") ok("推过窗口后立刻恢复可尝试",
  `401 还可尝试 4 次（进程钟算的话这里仍然是 429）`);
else bad("推过窗口后立刻恢复可尝试", `${reopened.status} 还可尝试=${reopened.left ?? "无"}：${reopened.text.slice(0, 90)}`);
const pruned = await rowCount(LK);
if (pruned === 1) ok("命中时顺手扫掉本桶过期行", `5 条旧行被 prune，只剩刚记的 1 条`);
else bad("命中时顺手扫掉本桶过期行", `该桶 ${pruned} 行，应为 1`);
await wipe(LK);

// ============================================================
// ③ 成功后清零跨两个入口（一个入口记的失败，另一个入口登录成功要能抹掉）
// ============================================================
if (!OK_EMAIL || !OK_PW) {
  bad("③ 成功后清零跨两个入口", ".env 缺 INK_TEST_EMAIL / INK_TEST_PASSWORD 夹具账号，这道闸门无法验清零");
} else {
  const RK = bucket("login", OK_EMAIL, LOGIN_IP);
  await wipe(RK);
  // 复用该账号已有的 UA，避免这次成功登录被当成"新设备"而真发提醒邮件
  const [uaRows] = await conn.query(
    "SELECT ua FROM sessions WHERE revoked = 0 AND user_id = (SELECT id FROM users WHERE email = ? LIMIT 1) ORDER BY id DESC LIMIT 1",
    [OK_EMAIL]
  );
  const knownUa = String(uaRows[0]?.ua ?? "");
  await call(NODE, "/api/auth/login", { email: OK_EMAIL, password: "wrong-password" }, LOGIN_IP, knownUa);
  const f2 = await call(JAVA, "/api/auth/login", { email: OK_EMAIL, password: "wrong-password" }, LOGIN_IP, knownUa);
  if (await rowCount(RK) === 2 && f2.left === "3") ok("夹具账号先记 2 次失败（两个入口各 1 次）", `剩余 ${f2.left ?? "?"} 次`);
  else bad("夹具账号先记 2 次失败（两个入口各 1 次）", `行数=${await rowCount(RK)} 剩余=${f2.left ?? "无"}`);
  const good = await call(JAVA, "/api/auth/login", { email: OK_EMAIL, password: OK_PW }, LOGIN_IP, knownUa);
  if (good.status === 200) {
    const cleared = await rowCount(RK);
    if (cleared === 0) ok("一个入口登录成功把另一个入口的失败计数一起清零", "共用同一个桶才清得掉");
    else bad("一个入口登录成功把另一个入口的失败计数一起清零", `该桶还剩 ${cleared} 行`);
    const again = await call(NODE, "/api/auth/login", { email: OK_EMAIL, password: "wrong-password" }, LOGIN_IP, knownUa);
    if (again.status === 401 && again.left === "4") ok("清零后经 Next 入口重新拿到 5 次额度", `还可尝试 ${again.left} 次`);
    else bad("清零后经 Next 入口重新拿到 5 次额度", `${again.status} 还可尝试=${again.left ?? "无"}`);
  } else {
    bad("一个入口登录成功把另一个入口的失败计数一起清零",
      `${good.status}：${good.text.slice(0, 90)}（夹具账号若开了两步验证，请换一个）`);
  }
  await wipe(RK);
}

// ============================================================
// ④ 同一张表容得下不同的上限（send-code 是 10 次）
//    用"已注册邮箱 + purpose=register"打：两个入口都在记完次数之后才判重复，
//    于是每次都 409 且一封邮件都不发——真发邮件的通道本闸门绝不碰。
// ============================================================
if (!OK_EMAIL) {
  bad("④ send-code 的 10 次上限跨两个入口", "缺 INK_TEST_EMAIL，无法构造'已注册邮箱'");
} else {
  const sk = `sendcode-ip:${SEND_IP}`;
  await conn.query("DELETE FROM rate_hits WHERE bucket = ?", [sk]);
  const [beforeMail] = await conn.query("SELECT COUNT(*) AS n FROM email_codes WHERE email = ?", [OK_EMAIL]);
  let sendOk = true;
  for (let i = 1; i <= 10; i++) {
    const base = i % 2 === 1 ? NODE : JAVA;
    const r = await call(base, "/api/auth/send-code", { email: OK_EMAIL, purpose: "register" }, SEND_IP);
    if (r.status !== 409) {
      bad(`send-code 第 ${i} 次（${base === NODE ? "node" : "java"}）应因邮箱已注册而 409`, `${r.status} ${r.text.slice(0, 80)}`);
      sendOk = false;
    }
  }
  const rows10 = await rowCount(sk);
  if (sendOk && rows10 === 10) ok("send-code 十次跨两个入口记账", "node/java 交替各 5 次，全部 409，桶里 10 行");
  else bad("send-code 十次跨两个入口记账", `桶里 ${rows10} 行，应答见上方失败`);
  const [afterMail] = await conn.query("SELECT COUNT(*) AS n FROM email_codes WHERE email = ?", [OK_EMAIL]);
  if (Number(afterMail[0].n) === Number(beforeMail[0].n)) ok("这一整段一封验证码都没发", "断言的是'闸门不打真邮件通道'这条纪律");
  else bad("这一整段一封验证码都没发", `email_codes 多了 ${Number(afterMail[0].n) - Number(beforeMail[0].n)} 行`);
  const over = await call(NODE, "/api/auth/send-code", { email: OK_EMAIL, purpose: "register" }, SEND_IP);
  if (over.status === 429 && over.retryAfter) ok("第 11 次换另一个入口也被上限拦住", `429 Retry-After=${over.retryAfter}s（上限 10 次）`);
  else bad("第 11 次换另一个入口也被上限拦住", `${over.status} ${over.text.slice(0, 80)}`);
  await conn.query("DELETE FROM rate_hits WHERE bucket = ?", [sk]);
}

// ============================================================
// ⑤ 边缘闸（120 次/分/IP）故意留在进程内存：一个请求一次库写，刹车就变成放大器
// ============================================================
for (let i = 0; i < 30; i++) {
  await fetch(`${NODE}/api/articles?limit=1`, { headers: { "x-forwarded-for": `203.0.113.${(i % 200) + 1}` } });
}
const [apiRows] = await conn.query("SELECT COUNT(*) AS n FROM rate_hits WHERE bucket LIKE 'api:%'");
if (Number(apiRows[0].n) === 0) ok("页面级流量不进共享账本", "30 个请求没写出 api:* 行——边缘闸仍是进程内滑窗，这是有意的");
else bad("页面级流量不进共享账本", `rate_hits 里出现 ${apiRows[0].n} 行 api:*，边缘闸被搬进了库`);

// 只有一条计数路径（rate_hits），两侧都不许再有进程内的兜底。
// P7f-2 之前这一条读的是 lib/rate-limit.ts 的源码（"Node 那一侧别留内存桶"）；那个文件已经
// 随 Node 的 /api 实现一起删了，于是判据改得**更硬**：文件存在本身就是红。
// 两半都还能红：谁把 ConcurrentHashMap 塞回 LoginGuard，或者谁在 Next 里新建一本限流账，都抓得住。
const legacyTs = path.join(root, "lib", "rate-limit.ts");
const javaSrc = fs.readFileSync(path.join(root, "server/src/main/java/com/inkstack/auth/LoginGuard.java"), "utf8");
const javaMemoryFallback = /ConcurrentHashMap|new HashMap<.*>\(\)/.test(javaSrc);
const nodeLedgerReborn = fs.existsSync(legacyTs);
if (!nodeLedgerReborn && !javaMemoryFallback) {
  ok("计数只有一条路径：rate_hits（Next 侧没有第二本账，Java 侧没有内存兜底）",
    "lib/rate-limit.ts 不存在 · LoginGuard 里没有 ConcurrentHashMap");
} else {
  bad("计数只有一条路径：rate_hits",
    [nodeLedgerReborn ? "lib/rate-limit.ts 又回来了（Node 侧另记一本账）" : "",
      javaMemoryFallback ? "LoginGuard 里有并发 Map（锁会被重启冲掉、多实例各算各的）" : ""]
      .filter(Boolean).join("；"));
}

// ============================================================
// ⑥ 共享的前提是"键由同一个来源决定"（middleware 转发的头与 Java 直读的头必须同源）
//    什么都不带时两个入口的兜底不同：Next 会把自己看到的 socket 对端注入 x-forwarded-for，
//    Tomcat 不注入、Java 落到 "local"。所以生产必须由 nginx 写 x-real-ip 且 TRUST_PROXY=1，
//    两个入口才读同一个源。这条是反向围栏：真把兜底对齐了，它就该变红并提醒改回来。
// ============================================================
const NK = `nohead-${Date.now()}@inkstack.dev`;
await call(NODE, "/api/auth/login", { email: NK, password: "wrong-password" }, "");
await call(JAVA, "/api/auth/login", { email: NK, password: "wrong-password" }, "");
const [nkRows] = await conn.query("SELECT DISTINCT bucket FROM rate_hits WHERE bucket LIKE ?", [`login:${NK}:%`]);
const nkKeys = nkRows.map((r) => r.bucket);
await conn.query("DELETE FROM rate_hits WHERE bucket LIKE ?", [`login:${NK}:%`]);
if (nkKeys.length === 2) {
  ok("没转发头时两个入口各成一个桶（已知边界，不是缺陷）", `两侧解出的 ip 不同：${nkKeys.map((b) => b.slice(6 + NK.length + 1)).join(" / ")}——生产由 nginx 写 x-real-ip 后两侧同源`);
} else {
  bad("没转发头时两个入口各成一个桶（已知边界，不是缺陷）", `只看到 ${nkKeys.length} 个桶：${nkKeys.join(" / ")}——若两侧兜底已对齐，请把这条改成断言"合成同一个桶"`);
}

// 前置那一次探针也记了一行，收掉：闸门不该在账本里留残渣
await conn.query("DELETE FROM rate_hits WHERE bucket = ?", [`login:${PREFLIGHT_EMAIL}:${LOGIN_IP}`]);

console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
await conn.end();
process.exit(fail ? 1 : 0);
