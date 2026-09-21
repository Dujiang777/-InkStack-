// 种子执行器：50 篇文章入库（published + approved），日期向今天收拢分布
// 用法：node scripts/seed50-run.mjs（在项目根目录，读 .env 的 DATABASE_URL）
// 幂等：slug 唯一键 + INSERT IGNORE，重复执行不会产生重复文章
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { part1 } from "./seed50-data1.mjs";
import { part2 } from "./seed50-data2.mjs";
import { part3 } from "./seed50-data3.mjs";

const env = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
const url = env.match(/^DATABASE_URL=(.+)$/m)[1].trim().replace(/^"|"$/g, "");

const all = [...part1, ...part2, ...part3];
if (all.length !== 50) {
  console.error(`文章数量不是 50：实际 ${all.length}`);
  process.exit(1);
}
// slug 去重校验
const slugs = new Set();
for (const a of all) {
  if (slugs.has(a.slug)) { console.error(`slug 重复：${a.slug}`); process.exit(1); }
  slugs.add(a.slug);
}

const conn = await mysql.createConnection(url);

// 确认作者存在（生产库：1=陈屿 2=林晚）
const [authors] = await conn.query("SELECT id FROM users WHERE id IN (1,2)");
if (authors.length < 2) {
  console.error("缺少作者账号（id=1/2），请先建用户");
  process.exit(1);
}

let inserted = 0, skipped = 0;
for (let i = 0; i < all.length; i++) {
  const a = all[i];
  // 日期分布：从 49 天前到今天，每天一篇（小时偏移为正会把最新一篇推到未来，
  // 触发列表 SQL 的 POWER 负底数错误 → 首页降级，故最新一篇至少落在 3 小时前）
  const d = new Date(Date.now() - (all.length - 1 - i) * 86400000 - 3600000 * 3 - i * 60000 * 7);
  const publishedAt = d.toISOString().slice(0, 19).replace("T", " ");
  const readCount = 300 + Math.floor(Math.random() * 4200);
  const likeCount = 5 + Math.floor(Math.random() * 60);
  const qaCount = Math.floor(Math.random() * 25);
  const [r] = await conn.query(
    `INSERT IGNORE INTO articles (author_id, slug, title, md_content, summary, cover_label, tags, status, review_status, read_count, like_count, agent_qa_count, published_at, created_at)
     VALUES (?,?,?,?,?,?,?,'published','approved',?,?,?,?,?)`,
    [a.author, a.slug, a.title, a.md, a.summary, a.cover, JSON.stringify(a.tags), readCount, likeCount, qaCount, publishedAt, publishedAt]
  );
  if (r.affectedRows > 0) inserted++; else skipped++;
}

// 标签覆盖统计
const [rows] = await conn.query(
  "SELECT tags FROM articles WHERE status='published' AND review_status='approved'"
);
const freq = {};
for (const r of rows) for (const t of JSON.parse(r.tags || "[]")) freq[t] = (freq[t] || 0) + 1;
const [cnt] = await conn.query("SELECT COUNT(*) n FROM articles WHERE status='published' AND review_status='approved'");
console.log(`seed50 done: inserted ${inserted}, skipped ${skipped}, published total now ${cnt[0].n}`);
console.log("tag coverage:", JSON.stringify(freq));
await conn.end();
