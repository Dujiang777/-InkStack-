// 清理：关闭测试号的两步验证（回到密码直登状态）
import mysql from "mysql2/promise";
const conn = await mysql.createConnection("mysql://root:root@localhost:3306/inkstack");
await conn.query(
  `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup = NULL WHERE email = 'test@inkstack.dev'`
);
const [rows] = await conn.query(`SELECT id, email, totp_enabled FROM users WHERE email = 'test@inkstack.dev'`);
console.log(JSON.stringify(rows));
await conn.query(`DELETE FROM email_codes WHERE email = 'test@inkstack.dev'`);
await conn.end();
