// 只读统计：按日分布查看 articles/users/tips/topup_orders（供管理大盘设计参考）
// 用法：node scripts/stats-daily.mjs
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const env = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
const url = env.match(/^DATABASE_URL=(.+)$/m)[1].trim().replace(/^"|"$/g, "");

const pool = mysql.createPool(url.replace("localhost", "127.0.0.1"));
const [a] = await pool.query("SELECT DATE_FORMAT(created_at,'%m-%d') d, COUNT(*) c FROM articles GROUP BY d ORDER BY d");
const [u] = await pool.query("SELECT DATE_FORMAT(created_at,'%m-%d') d, COUNT(*) c FROM users GROUP BY d ORDER BY d");
const [t] = await pool.query("SELECT DATE_FORMAT(created_at,'%m-%d') d, COUNT(*) c, SUM(amount) s FROM article_tips GROUP BY d ORDER BY d");
const [o] = await pool.query("SELECT DATE_FORMAT(created_at,'%m-%d') d, COUNT(*) c FROM topup_orders GROUP BY d ORDER BY d");
const [cm] = await pool.query("SELECT DATE_FORMAT(created_at,'%m-%d') d, COUNT(*) c FROM comments GROUP BY d ORDER BY d");
console.log("articles", JSON.stringify(a));
console.log("users", JSON.stringify(u));
console.log("tips", JSON.stringify(t));
console.log("topups", JSON.stringify(o));
console.log("comments", JSON.stringify(cm));
await pool.end();
