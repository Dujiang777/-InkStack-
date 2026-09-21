#!/usr/bin/env node
// 双轨对拍：同一请求分别打 Node 与 Java，逐字段比响应。
// 这是渐进迁移的质量闸门——每个模块切流前必须 diff 为空（或差异被显式承认）。
//
// 用法：
//   node scripts/parity.mjs /api/articles "/api/search?q=then"
//   node scripts/parity.mjs --login /api/me/overview
//   node scripts/parity.mjs --ignore 'articles.[*].boostUntil' /api/articles
//   METHOD:path:'{"json":"body"}' 形式可发写请求（慎用：会真的写库）
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opts = { node: 'http://localhost:3200', java: 'http://localhost:3101', login: false, ignore: [] };
const targets = [];
for (const arg of argv) {
  if (arg === '--login') opts.login = true;
  else if (arg.startsWith('--node=')) opts.node = arg.slice(7);
  else if (arg.startsWith('--java=')) opts.java = arg.slice(7);
  else if (arg.startsWith('--ignore=')) opts.ignore.push(...arg.slice(9).split(','));
  else targets.push(arg);
}
if (!targets.length) {
  console.error('至少给一个对拍目标，例如：node scripts/parity.mjs /api/articles');
  process.exit(2);
}

const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.INK_TEST_EMAIL, password: env.INK_TEST_PASSWORD }),
  });
  const setCookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  const session = setCookie.find((c) => c.startsWith('ink_session='));
  if (!session) throw new Error(`${base} 登录未拿到 ink_session：${await res.text()}`);
  return session;
}

function normalizePath(p) {
  // Git Bash(MSYS) 会把 "/api/x" 擅自改写成 "D:/Git/api/x"（POSIX 根被映射到 Git 安装目录）。
  // 对拍目标一定是接口路径，取第一个 /api/ 之后的片段即可还原，比剥盘符更稳。
  const api = p.indexOf('/api/');
  const clean = api > 0 ? p.slice(api) : p;
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function parseTarget(spec) {
  const parts = spec.split(':');
  if (parts.length > 2 && /^(GET|POST|PUT|PATCH|DELETE)$/.test(parts[0])) {
    return { method: parts[0], path: normalizePath(parts[1]), body: parts.slice(2).join(':') || undefined };
  }
  return { method: 'GET', path: normalizePath(spec), body: undefined };
}

async function call(base, spec, cookie) {
  const { method, path: p, body } = parseTarget(spec);
  const started = Date.now();
  let res;
  try {
    res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: method === 'GET' ? undefined : body,
      redirect: 'manual',
    });
  } catch (down) {
    // 一侧没起来时给出干净结论，而不是一串 undici 堆栈
    return { status: 0, json: undefined, text: `${base} 请求失败：${down.cause?.code ?? down.message}`, ms: Date.now() - started };
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, ms: Date.now() - started };
}

const IGNORE = new Set(opts.ignore);
const diffs = [];

function walk(a, b, trail) {
  if (IGNORE.has(trail)) return;
  if (a === b) return;
  const ta = Array.isArray(a) ? 'array' : typeof a;
  const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    diffs.push(`${trail}: 类型 node=${ta} java=${tb}（${JSON.stringify(a)} vs ${JSON.stringify(b)}）`);
    return;
  }
  if (ta === 'object' && a !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { diffs.push(`${trail}.${k}: java 多出此键 = ${JSON.stringify(b[k])}`); continue; }
      if (!(k in b)) { diffs.push(`${trail}.${k}: java 缺此键（node = ${JSON.stringify(a[k])}）`); continue; }
      walk(a[k], b[k], `${trail}.${k}`);
    }
    return;
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      diffs.push(`${trail}: 长度 node=${a.length} java=${b.length}`);
      // 顺序也是契约（信息流尤其），但仍逐项比前 min(len) 个以便定位
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${trail}.[${i}]`);
    return;
  }
  diffs.push(`${trail}: node=${JSON.stringify(a)} java=${JSON.stringify(b)}`);
}

let nodeCookie; let javaCookie;
if (opts.login) {
  nodeCookie = await login(opts.node);
  javaCookie = await login(opts.java);
}

let bad = 0;
for (const spec of targets) {
  const [n, j] = [await call(opts.node, spec, nodeCookie), await call(opts.java, spec, javaCookie)];
  diffs.length = 0;
  if (n.status !== j.status) diffs.push(`(status): node=${n.status} java=${j.status}`);
  if (n.json === undefined || j.json === undefined) {
    if (n.text !== j.text) diffs.push(`(非 JSON 响应) node=${n.text.slice(0, 80)} java=${j.text.slice(0, 80)}`);
  } else {
    walk(n.json, j.json, '');
  }
  const shape = n.json === undefined ? 'text' : `${Array.isArray(n.json) ? 'array' : 'object'}(${
    n.json && !Array.isArray(n.json) ? Object.keys(n.json).length : (n.json?.length ?? 0)})`;
  const ok = diffs.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${parseTarget(spec).method} ${parseTarget(spec).path}  [${n.status} ${shape}] node ${n.ms}ms / java ${j.ms}ms`);
  for (const d of diffs.slice(0, 12)) console.log(`      · ${d}`);
  if (diffs.length > 12) console.log(`      · …另有 ${diffs.length - 12} 处差异`);
}
console.log(`\n对拍 ${targets.length} 个目标，${bad} 个不一致`);
process.exit(bad ? 1 : 0);
