// 一次性运维脚本：在服务器上批量创建管理员账号 + 将指定用户提升为 developer
// 用法：node scripts/make-admins.mjs --admin=邮箱=密码=昵称 [--admin=...] [--dev-email=某邮箱] [--reset]
// 安全：账号与密码一律走命令行参数，脚本内不保留任何默认口令（开源合规）
// 幂等：邮箱已存在则跳过（不覆盖密码）；--reset 可强制重置密码
import { readFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import mysql from "mysql2/promise";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) ?? [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const DB_URL = get("DATABASE_URL");

function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

// 解析 --admin=email=password=nickname 参数（密码可含 = 号之外的任意字符；如含 = 请放在最后一段）
const adminArgs = process.argv.filter((a) => a.startsWith("--admin=")).map((a) => {
  const rest = a.slice("--admin=".length);
  const i1 = rest.indexOf("=");
  const i2 = rest.indexOf("=", i1 + 1);
  if (i1 < 1 || i2 < 0) throw new Error(`--admin 参数格式应为 邮箱=密码=昵称，收到：${rest}`);
  return { email: rest.slice(0, i1), password: rest.slice(i1 + 1, i2), nickname: rest.slice(i2 + 1) || "管理员" };
});
const reset = process.argv.includes("--reset");
// 开发者提升：--dev-email=某邮箱@xx.com（可多个）
const devEmails = process.argv.filter((a) => a.startsWith("--dev-email=")).map((a) => a.split("=")[1]);

if (!adminArgs.length && !devEmails.length) {
  console.log("示例：node scripts/make-admins.mjs --admin=admin@example.com=你的强密码=管理员 --dev-email=me@example.com");
  process.exit(0);
}

const pool = DB_URL
  ? mysql.createPool({ uri: DB_URL, waitForConnections: true, connectionLimit: 4 })
  : mysql.createPool({
      host: get("DB_HOST") || "127.0.0.1",
      user: get("DB_USER"),
      password: get("DB_PASSWORD"),
      database: get("DB_NAME"),
      waitForConnections: true,
      connectionLimit: 4,
    });

for (const a of adminArgs) {
  const [rows] = await pool.query(`SELECT id, password_hash FROM users WHERE email = ? LIMIT 1`, [a.email]);
  if (rows.length) {
    if (reset) {
      await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashPassword(a.password), rows[0].id]);
      console.log(`reset password: ${a.email}`);
    } else {
      console.log(`skip ${a.email} (already exists, id=${rows[0].id})`);
    }
    continue;
  }
  await pool.query(
    `INSERT INTO users (email, password_hash, nickname, role, points_balance, banned, created_at)
     VALUES (?, ?, ?, 'admin', 500, 0, NOW())`,
    [a.email, hashPassword(a.password), a.nickname]
  );
  console.log(`created admin: ${a.email}`);
}

// 提升开发者
for (const email of devEmails) {
  const [r] = await pool.query(`UPDATE users SET role = 'developer' WHERE email = ?`, [email]);
  console.log(`developer ${email}: affected=${r.affectedRows}`);
}

await pool.end();
console.log("DONE");
