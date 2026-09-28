#!/usr/bin/env node
// 付费墙专项校验：对拍只证明"两侧一致"，证明不了"两侧都正确"。
// 这里逐身份取样，覆盖 viewerUnlocked 那条 SQL 的三个分支（作者命中 / 已购命中 / 都不命中），
// 断言未解锁者拿到的正文必须被 SQL 层截断（行数 <= 6）。
//
//   node scripts/paywall-probe.mjs <slug>
//
// 两道判据寿命不同，所以要分开看：
//   · "截断生效"是**绝对**判据，一台实例就能判，Node 路由删掉之后照样守在这儿；
//   · "两栈一致"是**差分**判据，对岸没了就不成立——那时它记 SKIP 而不是绿。
// 早先这一道用 requireExecutor 硬要求 NODE 侧真是 Node，整前缀切走就拒绝起跑。那是对的保守，
// 但 P7f 之后 Node 永久不在，"一道永远拒绝起跑的闸门"等于被删掉，绝对判据也跟着一起失效。
// 所以现在改成：能跑的那半照跑，跑不了的那半如实说。
import fs from 'node:fs';
import path from 'node:path';
import { isCrossStack } from './gate-executor.mjs';

const root = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
// 地址优先级：shell 环境变量 > .env > 默认。反了会"以为在打临时实例、其实在打真 SMTP"。
const NODE = process.env.PARITY_NODE || env.PARITY_NODE || 'http://localhost:3200';
const JAVA = process.env.PARITY_JAVA || env.PARITY_JAVA || 'http://localhost:3101';
// 两侧执行者不同时才有差分可跑；相同时只剩绝对判据，如实标注。
const CROSS = await isCrossStack(NODE, JAVA);
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

// 单栈跑的时候以 JAVA 为准（Node 路由删掉之后它是活下来的那一侧）。
const SIDE = CROSS ? NODE : JAVA;
const cookies = { node: {}, java: {} };
for (const [label, email, password] of CASES) {
  if (!email) continue;
  if (CROSS) cookies.node[label] = await cookieOf(NODE, email, password);
  cookies.java[label] = await cookieOf(JAVA, email, password);
}
const cookieFor = (base) => (base === NODE && CROSS ? cookies.node : cookies.java);

console.log(`slug=${slug}` + (CROSS ? "" : `  （对岸不是另一套实现，只跑绝对判据；差分那一列记 —）`) + "\n");
let bad = 0;
for (const [label, email] of CASES) {
  const n = await detail(SIDE, cookieFor(SIDE)[label]);
  const j = CROSS ? await detail(JAVA, cookies.java[label]) : null;
  const same = j === null ? null : JSON.stringify(n) === JSON.stringify(j);
  if (same === false) bad++;
  const md = typeof n.md === "string" ? n.md : "";
  const lines = md ? md.split('\n').length : 0;
  const locked = (n.unlockPrice ?? 0) > 0 && !n.viewerUnlocked;
  const guardOk = !locked || lines <= 6;
  // 404 / 缺字段会让"截断防线=不适用"看起来像通过，所以取不到正文本身要算一个问题。
  if (n.missing || md === "") { bad++; }
  if (!guardOk) bad++;
  console.log(
    `${label.padEnd(6)} 两栈一致=${same === null ? '—' : (same ? '是' : '否')}  定价=${n.unlockPrice} ` +
    `有权读=${n.viewerUnlocked ? '是' : '否'} 正文=${lines}行/${md.length}字  ` +
    `截断防线=${n.missing ? '取不到文章!!' : (locked ? (guardOk ? '生效' : '失效!!') : '不适用')}`
  );
  if (same === false) {
    console.log('       差异字段:', Object.keys(n).filter((k) => JSON.stringify(n[k]) !== JSON.stringify(j[k])).join(', ') || '(键集不同)');
  }
}
console.log(`\n${bad ? '不通过 ' + bad + ' 项' : '全部通过'}` + (CROSS ? '' : '（差分项未跑）'));
process.exit(bad ? 1 : 0);
