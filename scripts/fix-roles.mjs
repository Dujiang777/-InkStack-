// 一次性运维脚本（Stage 2）：扩展 role 枚举 + 提升 developer + 验证
// 用法：node scripts/fix-roles.mjs
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const url = (env.match(/^DATABASE_URL=(.*)$/m) ?? [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

const pool = mysql.createPool({ uri: url, waitForConnections: true, connectionLimit: 4 });

// 1. 扩展 role 枚举（幂等：已是目标定义时 ALTER 会报重复列，捕获即可）
try {
  await pool.query(
    `ALTER TABLE users MODIFY role ENUM('reader','author','admin','developer') NOT NULL DEFAULT 'reader'`
  );
  console.log("ALTER role enum OK");
} catch (e) {
  console.log("ALTER skipped:", e.message);
}

// 2. 提升开发者（按邮箱）
const devs = ["1452667526@qq.com", "16204557+du-jiangjiang@users.noreply.gitee.com"];
for (const email of devs) {
  const [r] = await pool.query(`UPDATE users SET role = 'developer' WHERE email = ?`, [email]);
  console.log(`developer ${email}: affected=${r.affectedRows}`);
}

// 3. 核对结果
const [rows] = await pool.query(`SELECT id, email, nickname, role FROM users ORDER BY id`);
for (const r of rows) console.log(r.id, r.email, r.nickname, r.role);

await pool.end();
console.log("DONE");
