#!/usr/bin/env node
// 从根目录 .env 派生 Java 侧数据源配置到 server/config/application-local.properties。
// 目的：两栈共用同一套凭据与同一个 SESSION_SECRET，避免手抄导致会话不互通。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const raw = env.DATABASE_URL;
if (!raw) throw new Error('.env 缺少 DATABASE_URL');
const u = new URL(raw);

const targetDb = process.argv.includes('--prod-schema') ? u.pathname.slice(1) : 'inkstack_j';
const jdbc =
  `jdbc:mysql://${u.hostname}:${u.port || 3306}/${targetDb}` +
  '?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia%2FShanghai&useSSL=false&allowPublicKeyRetrieval=true';

const out = [
  '# 由 scripts/gen-java-env.mjs 生成，勿提交、勿手改',
  `INKSTACK_DB_URL=${jdbc}`,
  `INKSTACK_DB_USER=${decodeURIComponent(u.username)}`,
  `INKSTACK_DB_PASSWORD=${decodeURIComponent(u.password)}`,
  `SESSION_SECRET=${env.SESSION_SECRET ?? ''}`,
  `NEXT_PUBLIC_SITE_URL=${env.NEXT_PUBLIC_SITE_URL ?? ''}`,
  `TRUST_PROXY=${env.TRUST_PROXY ?? '0'}`,
  '',
].join('\n');

const dir = path.join(root, 'server', 'config');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'application-local.properties'), out, 'utf8');
console.log(`已写入 server/config/application-local.properties（库：${targetDb}）`);
