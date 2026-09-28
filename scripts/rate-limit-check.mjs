#!/usr/bin/env node
// 第十七道闸门：登录失败计数必须是两栈共用的同一本账，而不是各自进程里的内存桶。
//
// 为什么不能只做对拍：限流的行为是"第 6 次要拒绝"，而对拍比的是"两栈应答是否一致"。
// 双轨期两栈各算各的，同一 IP 在 Node 记 5 次、在 Java 也记 5 次，两边都觉得自己没锁，
// 于是第 11 次仍然放行——单看任何一栈的日志都完全正常。这类改动只能靠**跨栈累计**的断言来验：
// 一侧记的数，另一侧必须立刻看得见；一侧清零，另一侧必须跟着解锁。
//
// 顺带钉住两件相邻的事：窗口的时钟是 MySQL 的 NOW(3)（两栈的机器钟可以漂移，只有同一个源
// 才会算出同一个 Retry-After）；以及边缘闸（120 次/分/IP）**故意**留在进程内存里——
// 它每个请求都要过一次，搬进库就把 DoS 刹车变成了 DoS 放大器。
//
//   node scripts/rate-limit-check.mjs
//
// 前提：两栈都在跑，且 /api/auth 还没整前缀切给 Java（脚本会自证这一点，切了就拒绝跑）。
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
      // ip 传空串表示"什么转发头都不带"：两栈各自的兜底不一样，最后一条用例要的就是这个差别
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

// —— 前置：表存在 + 两侧真的是两个执行者 ——
const [tbl] = await conn.query("SHOW TABLES LIKE 'rate_hits'");
if (tbl.length === 0) {
  console.error("FAIL  rate_hits 表不存在：限流还没有共享存储。");
  console.error("      起一次 Java 实例让 SchemaBootstrap 建表（db/schema.sql 已有该表定义），再来跑这道闸门。");
  process.exit(1);
}
const live = await Promise.allSettled([fetch(`${NODE}/api/articles?limit=1`), fetch(`${JAVA}/api/articles?limit=1`)]);
if (live.some((r) => r.status === "rejected")) {
  console.error(`FAIL  两栈没都在跑（node=${NODE} java=${JAVA}），跨栈断言无从做起`);
  process.exit(1);
}
const PREFLIGHT_EMAIL = `preflight-${Date.now()}@inkstack.dev`;
const who = await call(NODE, "/api/auth/login", { email: PREFLIGHT_EMAIL, password: "x" }, LOGIN_IP);
if (who.backend === "inkstack-java") {
  console.error("FAIL  打到 Node 端口的 /api/auth/login 其实是 Java 答的（x-backend=inkstack-java）。");
  console.error("      这时两侧是同一个执行者，'跨栈累计'会退化成自己跟自己比、必然全绿。");
  console.error("      把 JAVA_ROUTES 里的 /api/auth 前缀去掉再跑（这道闸门验的正是双轨期的共用账本）。");
  process.exit(1);
}
if (!who.backend) ok("前置：两侧是两个执行者", `node 端口本地应答，java 端口另算`);
else bad("前置：两侧是两个执行者", `node 端口应答带 x-backend=${who.backend}`);

// ============================================================
// ① 一侧记的数，另一侧立刻看得见（max=5，先记再判）
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
  if ((side === "java") !== (r.backend === "inkstack-java")) {
    bad(`第 ${i} 次失败确实由 ${side} 应答`, `x-backend=${r.backend || "无"}`);
    stepOk = false;
  }
}
if (stepOk) ok("五连失败交叉在两栈间累计", "node·node·java·node·java 每次都报出正确的剩余次数（各算各的话第 3 次起就报错了）");
const afterFive = await rowCount(LK);
if (afterFive === 5) ok("窗口内行数等于失败次数", "计数落在 rate_hits，不再活在任一进程的 Map 里");
else bad("窗口内行数等于失败次数", `rate_hits 里该桶 ${afterFive} 行，应为 5`);

// 第 5 次（在 Java 上）当场就锁，所以第 6 次在 Node 上必须是 429 而不是再来一次 401
const lockedNode = await call(NODE, "/api/auth/login", { email: PROBE_EMAIL, password: "wrong-password" }, LOGIN_IP);
if (lockedNode.status === 429 && lockedNode.retryAfter) ok("Java 记满 5 次后 Node 侧拒绝并带 Retry-After",
  `429 Retry-After=${lockedNode.retryAfter}s`);
else bad("Java 记满 5 次后 Node 侧拒绝并带 Retry-After", `${lockedNode.status} retry-after=${lockedNode.retryAfter || "无"}：${lockedNode.text.slice(0, 90)}`);

// 锁定中的请求走的是 verdict（只查不记），不该继续往账本里加行
const stillFive = await rowCount(LK);
if (stillFive === 5) ok("锁定中的请求不再累加计数", "verdict 只查不记，否则被锁的人会越锁越久");
else bad("锁定中的请求不再累加计数", `该桶变成 ${stillFive} 行，应仍是 5`);

// Retry-After 由数据库那把钟算出来，两栈必须给同一个答案
const lockedJava = await call(JAVA, "/api/auth/login", { email: PROBE_EMAIL, password: "wrong-password" }, LOGIN_IP);
const ra = [Number(lockedNode.retryAfter), Number(lockedJava.retryAfter)];
if (lockedJava.status === 429 && Math.abs(ra[0] - ra[1]) <= 3) ok("两栈报出同一个解锁时间", `node=${ra[0]}s java=${ra[1]}s`);
else bad("两栈报出同一个解锁时间", `node=${ra[0]}s java=${ra[1]}s（java 状态 ${lockedJava.status}）`);

// ============================================================
// ② 窗口的时钟是 MySQL 的：把行推到窗口外，两栈必须同时解锁
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
// ③ 成功后清零是跨栈的（Node 记的失败，Java 登录成功要能抹掉）
// ============================================================
if (!OK_EMAIL || !OK_PW) {
  bad("③ 成功后清零跨栈", ".env 缺 INK_TEST_EMAIL / INK_TEST_PASSWORD 夹具账号，这道闸门无法验清零");
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
  if (await rowCount(RK) === 2 && f2.left === "3") ok("夹具账号先记 2 次失败（两栈各 1 次）", `剩余 ${f2.left ?? "?"} 次`);
  else bad("夹具账号先记 2 次失败（两栈各 1 次）", `行数=${await rowCount(RK)} 剩余=${f2.left ?? "无"}`);
  const good = await call(JAVA, "/api/auth/login", { email: OK_EMAIL, password: OK_PW }, LOGIN_IP, knownUa);
  if (good.status === 200) {
    const cleared = await rowCount(RK);
    if (cleared === 0) ok("Java 侧登录成功把 Node 侧的失败计数一起清零", "共用同一个桶才清得掉");
    else bad("Java 侧登录成功把 Node 侧的失败计数一起清零", `该桶还剩 ${cleared} 行`);
    const again = await call(NODE, "/api/auth/login", { email: OK_EMAIL, password: "wrong-password" }, LOGIN_IP, knownUa);
    if (again.status === 401 && again.left === "4") ok("清零后 Node 侧重新拿到 5 次额度", `还可尝试 ${again.left} 次`);
    else bad("清零后 Node 侧重新拿到 5 次额度", `${again.status} 还可尝试=${again.left ?? "无"}`);
  } else {
    bad("Java 侧登录成功把 Node 侧的失败计数一起清零",
      `${good.status}：${good.text.slice(0, 90)}（夹具账号若开了两步验证，请换一个）`);
  }
  await wipe(RK);
}

// ============================================================
// ④ 同一张表容得下不同的上限（send-code 是 10 次）
//    用"已注册邮箱 + purpose=register"打：两侧都在记完次数之后才判重复，
//    于是每次都 409 且一封邮件都不发——真发邮件的通道本闸门绝不碰。
// ============================================================
if (!OK_EMAIL) {
  bad("④ send-code 的 10 次上限跨栈", "缺 INK_TEST_EMAIL，无法构造'已注册邮箱'");
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
  if (sendOk && rows10 === 10) ok("send-code 十次跨栈记账", "node/java 交替各 5 次，全部 409，桶里 10 行");
  else bad("send-code 十次跨栈记账", `桶里 ${rows10} 行，应答见上方失败`);
  const [afterMail] = await conn.query("SELECT COUNT(*) AS n FROM email_codes WHERE email = ?", [OK_EMAIL]);
  if (Number(afterMail[0].n) === Number(beforeMail[0].n)) ok("这一整段一封验证码都没发", "断言的是'闸门不打真邮件通道'这条纪律");
  else bad("这一整段一封验证码都没发", `email_codes 多了 ${Number(afterMail[0].n) - Number(beforeMail[0].n)} 行`);
  const over = await call(NODE, "/api/auth/send-code", { email: OK_EMAIL, purpose: "register" }, SEND_IP);
  if (over.status === 429 && over.retryAfter) ok("第 11 次在另一侧被上限拦住", `429 Retry-After=${over.retryAfter}s（上限 10 次）`);
  else bad("第 11 次在另一侧被上限拦住", `${over.status} ${over.text.slice(0, 80)}`);
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

const tsSrc = fs.readFileSync(path.join(root, "lib/rate-limit.ts"), "utf8");
const javaSrc = fs.readFileSync(path.join(root, "server/src/main/java/com/inkstack/auth/LoginGuard.java"), "utf8");
if (!/__inkRateBuckets|Map<string, number\[\]>/.test(tsSrc) && !/ConcurrentHashMap/.test(javaSrc)) {
  ok("两栈都没有留进程内计数兜底", "失败次数只有一条路径：rate_hits");
} else {
  bad("两栈都没有留进程内计数兜底", "还有一侧在用内存桶，双轨期就会各算各的");
}

// ============================================================
// ⑥ 共享的前提是"键由同一个来源决定"
//    什么都不带时两栈的兜底不同：Next 会把自己看到的 socket 对端注入 x-forwarded-for，
//    Tomcat 不注入、Java 落到 "local"。所以生产必须由 nginx 写 x-real-ip 且 TRUST_PROXY=1，
//    两栈才读同一个源。这条是反向围栏：真把兜底对齐了，它就该变红并提醒改回来。
// ============================================================
const NK = `nohead-${Date.now()}@inkstack.dev`;
await call(NODE, "/api/auth/login", { email: NK, password: "wrong-password" }, "");
await call(JAVA, "/api/auth/login", { email: NK, password: "wrong-password" }, "");
const [nkRows] = await conn.query("SELECT DISTINCT bucket FROM rate_hits WHERE bucket LIKE ?", [`login:${NK}:%`]);
const nkKeys = nkRows.map((r) => r.bucket);
await conn.query("DELETE FROM rate_hits WHERE bucket LIKE ?", [`login:${NK}:%`]);
if (nkKeys.length === 2) {
  ok("没转发头时两栈各成一个桶（已知边界，不是缺陷）", `两侧解出的 ip 不同：${nkKeys.map((b) => b.slice(6 + NK.length + 1)).join(" / ")}——生产由 nginx 写 x-real-ip 后两侧同源`);
} else {
  bad("没转发头时两栈各成一个桶（已知边界，不是缺陷）", `只看到 ${nkKeys.length} 个桶：${nkKeys.join(" / ")}——若两侧兜底已对齐，请把这条改成断言"合成同一个桶"`);
}

// 前置那一次探针也记了一行，收掉：闸门不该在账本里留残渣
await conn.query("DELETE FROM rate_hits WHERE bucket = ?", [`login:${PREFLIGHT_EMAIL}:${LOGIN_IP}`]);

console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
await conn.end();
process.exit(fail ? 1 : 0);
