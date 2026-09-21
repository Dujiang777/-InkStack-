#!/usr/bin/env node
// 付费墙专项校验：对拍只证明"两侧一致"，证明不了"两侧都正确"。
// 这里逐身份取样，覆盖 viewerUnlocked 那条 SQL 的三个分支（作者命中 / 已购命中 / 都不命中），
// 断言未解锁者拿到的正文必须被 SQL 层截断（行数 <= 6）。
//
//   node scripts/paywall-probe.mjs <slug>
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
// 地址优先级：shell 环境变量 > .env > 默认。反了会"以为在打临时实例、其实在打真 SMTP"。
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || 'http://localhost:3200';
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || 'http://localhost:3101';
const slug = (process.argv[2] ?? '').replace(/^\/+/, '');
if (!slug) {
  console.error('用法：node scripts/paywall-probe.mjs <slug>');
  process.exit(2);
}

async function cookieOf(base, email, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`在 ${base} 以 ${email} 登录失败：${JSON.stringify(body)}`);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('ink_session='));
}

async function detail(base, cookie) {
  const res = await fetch(base + '/api/articles/' + encodeURIComponent(slug), cookie ? { headers: { cookie } } : {});
  if (res.status === 404) return { missing: true, status: 404 };
  const body = await res.json();
  return body.article ?? body;
}

const CASES = [
  ['匿名读者', null, null],
  ['运营(管理员)', env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD],
  ['已购读者', env.INK_WRITER_EMAIL, env.INK_WRITER_PASSWORD],
  ['登录但未购非作者', env.INK_PROBE_EMAIL, env.INK_PROBE_PASSWORD],
];

const cookies = { node: {}, java: {} };
for (const [label, email, password] of CASES) {
  if (!email) continue;
  cookies.node[label] = await cookieOf(NODE, email, password);
  cookies.java[label] = await cookieOf(JAVA, email, password);
}

console.log(`slug=${slug}\n`);
let bad = 0;
for (const [label, email] of CASES) {
  const n = await detail(NODE, cookies.node[label]);
  const j = await detail(JAVA, cookies.java[label]);
  const same = JSON.stringify(n) === JSON.stringify(j);
  if (!same) bad++;
  const lines = n.md ? n.md.split('\n').length : 0;
  const locked = (n.unlockPrice ?? 0) > 0 && !n.viewerUnlocked;
  const guardOk = !locked || lines <= 6;
  if (!guardOk) bad++;
  console.log(
    `${label.padEnd(6)} 两栈一致=${same ? '是' : '否'}  定价=${n.unlockPrice} 有权读=${n.viewerUnlocked ? '是' : '否'} ` +
    `正文=${lines}行/${n.md.length}字  截断防线=${locked ? (guardOk ? '生效' : '失效!!') : '不适用'}`
  );
  if (!same) {
    console.log('       差异字段:', Object.keys(n).filter((k) => JSON.stringify(n[k]) !== JSON.stringify(j[k])).join(', ') || '(键集不同)');
  }
}
console.log(`\n${bad ? '不通过 ' + bad + ' 项' : '全部通过'}`);
process.exit(bad ? 1 : 0);
