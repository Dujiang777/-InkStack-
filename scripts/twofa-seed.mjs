// 测试辅助：给 test@inkstack.dev 预置一枚已知的两步验证邮箱临时码（仅本地测试用）
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

const email = "test@inkstack.dev";
const code = "654321";
const hash = createHash("sha256").update(`${email}::${code}`).digest("hex");
const conn = await mysql.createConnection("mysql://root:root@localhost:3306/inkstack");
await conn.query(`DELETE FROM email_codes WHERE email = ? AND purpose = 'twofa'`, [email]);
await conn.query(
  `INSERT INTO email_codes (email, code_hash, purpose, expires_at)
   VALUES (?, ?, 'twofa', DATE_ADD(NOW(3), INTERVAL 10 MINUTE))`,
  [email, hash]
);
const [rows] = await conn.query(
  `SELECT id, purpose, expires_at FROM email_codes WHERE email = ? AND purpose = 'twofa'`,
  [email]
);
console.log("seeded:", JSON.stringify(rows));
await conn.end();
