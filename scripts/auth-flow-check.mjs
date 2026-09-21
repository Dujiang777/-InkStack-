#!/usr/bin/env node
// P1b 跨栈认证流程闸门：验证码与会话必须"一侧签发、另一侧消费"才算真互通。
//
// 为什么不能只做同栈自测：两栈共用同一张 email_codes / sessions 表，
// 但哈希口径各写各的（sha256(`${email}::${code}`)、token_hash、FROM_UNIXTIME 时效）。
// 任何一处细节走岔，同栈测试照样全绿——只有交叉使用才会暴露。
//
//   node scripts/auth-flow-check.mjs
//
// 依赖 dev 降级通道：SMTP 未配置时两栈都会在应答里回显 devCode。
// 配了 SMTP 就把脚本停在这里，绝不去真人邮箱里捞码。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
// 地址优先级：shell 环境变量 > .env > 默认。写反了会出现"以为在打临时实例、其实在打真 SMTP"。
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101";

let pass = 0;
let fail = 0;
const created = [];

function ok(label, detail = "") {
  pass++;
  console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
}
function bad(label, detail) {
  fail++;
  console.log(`FAIL  ${label}  — ${detail}`);
}

async function post(base, p, body, cookie) {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 非 JSON 由调用方判定 */ }
  return { status: res.status, json, text, cookie: (res.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0]).find((c) => c.startsWith("ink_session=")) };
}

/** 取码：只认 dev 回显通道。 */
async function devCode(base, email, purpose) {
  const r = await post(base, "/api/auth/send-code", { email, purpose });
  if (!r.json?.ok) return { error: `send-code ${r.status}: ${r.text.slice(0, 90)}` };
  if (!r.json.devCode) {
    return { error: "该栈未回显 devCode（SMTP 已配置或 NODE_ENV=production），无法自动取码——请把本用例改成人工验证" };
  }
  return { code: r.json.devCode };
}

const PW = "Migrate2026x";
const PW_NEW = "Migrate2026y";
const stamp = Date.now();

// —— 1. Node 签发 → Java 消费（注册）——
const e1 = `p1b-node-issue-${stamp}@inkstack.dev`;
created.push(e1);
const c1 = await devCode(NODE, e1, "register");
if (c1.error) bad("Node 签发注册码", c1.error);
else {
  const r = await post(JAVA, "/api/auth/register",
    { nickname: "跨栈一号", email: e1, password: PW, code: c1.code });
  if (r.status === 200 && r.json?.ok && r.cookie) ok("Node 签发 → Java 注册", `user.id=${r.json.user?.id}`);
  else bad("Node 签发 → Java 注册", `${r.status} ${r.text.slice(0, 120)}`);
}

// —— 2. Java 签发 → Node 消费（注册）——
const e2 = `p1b-java-issue-${stamp}@inkstack.dev`;
created.push(e2);
const c2 = await devCode(JAVA, e2, "register");
if (c2.error) bad("Java 签发注册码", c2.error);
else {
  const r = await post(NODE, "/api/auth/register",
    { nickname: "跨栈二号", email: e2, password: PW, code: c2.code });
  if (r.status === 200 && r.json?.ok) ok("Java 签发 → Node 注册", `user.id=${r.json.user?.id}`);
  else bad("Java 签发 → Node 注册", `${r.status} ${r.text.slice(0, 120)}`);
}

// —— 3. 一码两吃必须失败（消费是条件删除，不是"比对后删"）——
if (c2.code) {
  const again = await post(NODE, "/api/auth/register",
    { nickname: "跨栈二号", email: e2, password: PW, code: c2.code });
  if (again.status === 400 && /已被使用|请先获取/.test(again.json?.error ?? "")) {
    ok("重复消费同一枚码被拒", again.json.error);
  } else {
    bad("重复消费同一枚码被拒", `${again.status} ${again.text.slice(0, 120)}`);
  }
}

// —— 4. Java 注册的账号，两栈都能登录（口令哈希互认）——
for (const [who, base] of [["node", NODE], ["java", JAVA]]) {
  const r = await post(base, "/api/auth/login", { email: e1, password: PW });
  if (r.status === 200 && r.json?.ok && r.cookie) ok(`Java 建的号可在 ${who} 登录`, `uid=${r.json.user?.id}`);
  else bad(`Java 建的号可在 ${who} 登录`, `${r.status} ${r.text.slice(0, 120)}`);
}

// —— 5. 假码注册：错误码要消耗尝试次数，且不得泄露邮箱是否存在 ——
const wrong = await post(JAVA, "/api/auth/register",
  { nickname: "试探者", email: e1, password: PW, code: "000000" });
if (wrong.status === 400 && /验证码|过期|获取/.test(wrong.json?.error ?? "")) {
  ok("假码注册停在验证码分支", wrong.json.error);
} else {
  bad("假码注册停在验证码分支", `${wrong.status} ${wrong.text.slice(0, 120)}`);
}

// —— 6. 重置：Node 签发 reset 码 → Java 消费改密 → 旧密码两栈都失效、新密码两栈都有效 ——
// 重置前先攥一枚真实 Cookie：重置的语义就是"全部设备立即下线"，它必须在两栈同时失效。
const preReset = await post(NODE, "/api/auth/login", { email: e1, password: PW });
if (!preReset.cookie) bad("重置前取得会话 Cookie", `${preReset.status} ${preReset.text.slice(0, 120)}`);
else ok("重置前取得会话 Cookie");

const c6 = await devCode(NODE, e1, "reset");
if (c6.error) bad("Node 签发重置码", c6.error);
else {
  const r = await post(JAVA, "/api/auth/reset", { email: e1, code: c6.code, password: PW_NEW });
  if (r.status === 200 && r.json?.ok) ok("Node 签发 → Java 重置密码", r.json.hint);
  else bad("Node 签发 → Java 重置密码", `${r.status} ${r.text.slice(0, 120)}`);
}
const oldPw = await post(NODE, "/api/auth/login", { email: e1, password: PW });
if (oldPw.status === 401) ok("重置后旧密码失效（Node 侧确认）");
else bad("重置后旧密码失效", `仍是 ${oldPw.status}`);
const newPwJava = await post(JAVA, "/api/auth/login", { email: e1, password: PW_NEW });
if (newPwJava.status === 200 && newPwJava.json?.ok) ok("新密码在 Java 侧可登录");
else bad("新密码在 Java 侧可登录", `${newPwJava.status} ${newPwJava.text.slice(0, 120)}`);

// —— 7. 重置前那枚 Cookie 在两栈都立即失效（sessions 吊销跨栈生效）——
if (preReset.cookie) {
  for (const [who, base] of [["node", NODE], ["java", JAVA]]) {
    const me = await fetch(base + "/api/auth/me", { headers: { cookie: preReset.cookie } }).then((r) => r.json());
    if (me.user == null) ok(`重置前 Cookie 在 ${who} 已失效`);
    else bad(`重置前 Cookie 在 ${who} 已失效`, `仍认得 uid=${me.user.id}`);
  }
}

console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);

// —— 清理：测试账号与它的会话/验证码全部删掉，不污染克隆库 ——
if (process.argv.includes("--keep")) {
  console.log("已按要求保留测试账号：" + created.join(", "));
} else {
  const mysql = (await import("mysql2/promise")).default;
  const conn = await mysql.createConnection(env.DATABASE_URL);
  for (const email of created) {
    const [rows] = await conn.query("SELECT id FROM users WHERE email = ?", [email]);
    for (const r of rows) {
      // users 被多张表外键引用（point_ledger 等），先按 information_schema 找出子表逐个清，
      // 不然清理会因 ER_ROW_IS_REFERENCED_2 中断、把测试账号留在克隆库里。
      const [fks] = await conn.query(
        `SELECT k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col
           FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.REFERENCED_TABLE_NAME = 'users' AND k.TABLE_SCHEMA = DATABASE()`
      );
      for (const fk of fks) {
        // 绝不对 users 自身做批量删：若存在 referred_by 这类自引用外键，
        // "删子表"会变成"删掉引用了我的其它真实用户"。
        if (String(fk.tbl).toLowerCase() === "users") continue;
        await conn.query(`DELETE FROM \`${fk.tbl}\` WHERE \`${fk.col}\` = ?`, [r.id]);
      }
      await conn.query("DELETE FROM sessions WHERE user_id = ?", [r.id]);
      await conn.query("DELETE FROM audit_logs WHERE user_id = ?", [r.id]);
    }
    await conn.query("DELETE FROM users WHERE email = ?", [email]);
    await conn.query("DELETE FROM email_codes WHERE email = ?", [email]);
  }
  await conn.end();
  console.log(`已清理测试账号 ${created.length} 个及其会话/审计/验证码记录`);
}
process.exit(fail ? 1 : 0);
