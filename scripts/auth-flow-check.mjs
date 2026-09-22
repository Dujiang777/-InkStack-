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
  return send("POST", base, p, body, cookie);
}

async function send(method, base, p, body, cookie) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
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

/**
 * RFC 6238 当前码：HMAC-SHA1 / 30 秒步长 / 6 位，动态截断取低 31 位。
 * 脚本自己实现一份是刻意的：拿某一侧的实现当既真值，就永远测不出另一侧的 base32 或截断写错。
 */
async function totpNow(secretB32) {
  const { createHmac } = await import("node:crypto");
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretB32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const mac = createHmac("sha1", key).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

// —— 8. 两步验证全生命周期跨栈：Node 生成密钥 → Java 校验并开启 → 两栈都要二因子 → 备份码可用且一次一毁 → Node 关闭 ——
const PW3 = "Migrate2026z";
const login1 = await post(NODE, "/api/auth/login", { email: e1, password: PW_NEW });
const stage = await post(NODE, "/api/security/2fa", {}, login1.cookie);
const secret = stage.json?.secret;
if (!secret || !/^[A-Z2-7]{32}$/.test(secret)) bad("Node 生成 TOTP 密钥", `${stage.status} ${stage.text.slice(0, 100)}`);
else ok("Node 生成 TOTP 密钥", `base32 ${secret.length} 位`);

let backup = null;
let enabled = false;
if (!secret) {
  bad("Java 校验 Node 生成的密钥并开启", "前置密钥没拿到，后续 2FA 用例全部未跑");
} else {
  const code = await totpNow(secret);
  // 注意是 PUT：POST 那一支是"重新生成密钥"，用错方法会把整段测试变成假通过
  const on = await send("PUT", JAVA, "/api/security/2fa", { code }, login1.cookie);
  backup = on.json?.backupCodes ?? null;
  enabled = on.status === 200 && Array.isArray(backup) && backup.length === 10
    && /^\w{4}-\w{4}$/.test(backup[0] ?? "");
  if (enabled) ok("Java 校验 Node 生成的密钥并开启", `备份码 ${backup[0]}…共 10 枚`);
  else bad("Java 校验 Node 生成的密钥并开启", `${on.status} ${on.text.slice(0, 120)}`);
}

if (enabled) {
  const needCode = await post(NODE, "/api/auth/login", { email: e1, password: PW_NEW });
  if (needCode.json?.need2fa === true) ok("开启后 Node 登录要求二因子");
  else bad("开启后 Node 登录要求二因子", JSON.stringify(needCode.json).slice(0, 120));
  const noCode = await post(JAVA, "/api/auth/login", { email: e1, password: PW_NEW });
  if (noCode.json?.need2fa === true) ok("开启后 Java 登录同样要求二因子");
  else bad("开启后 Java 登录同样要求二因子", JSON.stringify(noCode.json).slice(0, 120));

  const javaLogin = await post(JAVA, "/api/auth/login",
    { email: e1, password: PW_NEW, totp: await totpNow(secret) });
  if (javaLogin.status === 200 && javaLogin.json?.ok) ok("Java 登录接受同一个 TOTP 码");
  else bad("Java 登录接受同一个 TOTP 码", `${javaLogin.status} ${javaLogin.text.slice(0, 120)}`);

  const viaBackup = await post(NODE, "/api/auth/login", { email: e1, password: PW_NEW, totp: backup[0] });
  if (viaBackup.status === 200 && viaBackup.json?.ok) ok("备份码在 Node 侧可登录");
  else bad("备份码在 Node 侧可登录", `${viaBackup.status} ${viaBackup.text.slice(0, 120)}`);
  const burnJava = await post(JAVA, "/api/auth/login", { email: e1, password: PW_NEW, totp: backup[1] });
  const burnAgain = await post(JAVA, "/api/auth/login", { email: e1, password: PW_NEW, totp: backup[1] });
  if (burnJava.status === 200 && burnAgain.status === 401) {
    ok("备份码一次一毁（Java 侧）", burnAgain.json?.error);
  } else bad("备份码一次一毁（Java 侧）", `首次 ${burnJava.status} / 二次 ${burnAgain.status}`);
}

if (enabled) {
  // 跨栈关闭：Java 开的，由 Node 关——两栈对 totp_* 三列的读写必须互通
  const off = await send("DELETE", NODE, "/api/security/2fa",
    { password: PW_NEW, code: await totpNow(secret) }, login1.cookie);
  if (off.status === 200 && off.json?.ok) ok("Node 关闭 Java 开启的两步验证");
  else bad("Node 关闭 Java 开启的两步验证", `${off.status} ${off.text.slice(0, 120)}`);
  const after = await post(JAVA, "/api/auth/login", { email: e1, password: PW_NEW });
  if (after.status === 200 && after.json?.ok && !after.json.need2fa) ok("关闭后 Java 登录不再要二因子");
  else bad("关闭后 Java 登录不再要二因子", JSON.stringify(after.json).slice(0, 120));
}

// —— 9. 改密：保留当前会话、下线其他设备（跨栈看得到吊销）——
const keepMe = await post(JAVA, "/api/auth/login", { email: e1, password: PW_NEW });
const other = await post(NODE, "/api/auth/login", { email: e1, password: PW_NEW });
const changed = await post(JAVA, "/api/security/password",
  { oldPassword: PW_NEW, newPassword: PW3 }, keepMe.cookie);
if (changed.status === 200 && changed.json?.ok && changed.json.revoked >= 1) {
  ok("Java 改密并下线其他设备", `revoked=${changed.json.revoked}`);
} else bad("Java 改密并下线其他设备", `${changed.status} ${changed.text.slice(0, 140)}`);
const stillOn = await fetch(NODE + "/api/auth/me", { headers: { cookie: keepMe.cookie ?? "" } }).then((r) => r.json());
if (stillOn.user?.id) ok("改密后当前会话在 Node 仍有效");
else bad("改密后当前会话在 Node 仍有效", JSON.stringify(stillOn).slice(0, 120));
const kicked = await fetch(JAVA + "/api/auth/me", { headers: { cookie: other.cookie ?? "" } }).then((r) => r.json());
if (kicked.user == null) ok("改密前另一台设备的会话已下线");
else bad("改密前另一台设备的会话已下线", `仍认得 uid=${kicked.user.id}`);
const wrongOld = await post(JAVA, "/api/security/password",
  { oldPassword: "wrongpass123", newPassword: PW3 }, keepMe.cookie);
if (wrongOld.status === 401 && /还可尝试/.test(wrongOld.json?.error ?? "")) ok("旧密码错误时给出剩余次数", wrongOld.json.error);
else bad("旧密码错误时给出剩余次数", `${wrongOld.status} ${wrongOld.text.slice(0, 120)}`);

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
