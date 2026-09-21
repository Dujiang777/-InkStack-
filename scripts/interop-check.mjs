#!/usr/bin/env node
// P1 验收：证明 ink_session 在两栈之间真正互通。
// 不是自说自话——每一跳都要求"对面那套后端"用自己完整的校验链
// （HMAC 签名 + sessions 表 + banned + uid 一致）认下对方签发的 Cookie。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const NODE = process.env.NODE_BASE ?? 'http://localhost:3200';
const JAVA = process.env.JAVA_BASE ?? 'http://localhost:3101';
const EMAIL = env.INK_TEST_EMAIL;
const PASSWORD = env.INK_TEST_PASSWORD;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(base, method, urlPath, { cookie, body } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留原文 */ }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('ink_session='));
  return { status: res.status, json, text, sessionCookie: session ?? null, raw: setCookie };
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  return ['id', 'nickname', 'email', 'role'].every((k) => String(a[k]) === String(b[k]));
}

/** 在 issuer 上登录，然后要求两侧后端都认下这枚 Cookie。 */
async function handoff(label, issuer, other) {
  const login = await api(issuer, 'POST', '/api/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  if (!login.json?.ok || !login.sessionCookie) {
    check(`${label}：${issuer} 登录`, false, `status=${login.status} body=${login.text.slice(0, 120)}`);
    return;
  }
  const cookie = login.sessionCookie;
  check(`${label}：${issuer} 登录并签发 ink_session`, true, cookie.slice(0, 46) + '…');

  const self = await api(issuer, 'GET', '/api/auth/me', { cookie });
  const peer = await api(other, 'GET', '/api/auth/me', { cookie });
  check(`${label}：${issuer} 自验通过`, !!self.json?.user, `user=${JSON.stringify(self.json?.user)}`);
  const ok = !!peer.json?.user && sameIdentity(self.json.user, peer.json.user);
  check(`${label}：${other} 认下对方签发的会话`, ok,
    `peer=${JSON.stringify(peer.json?.user ?? peer.json ?? peer.text?.slice(0, 80))}`);

  // 吊销必须跨栈生效：在 issuer 上登出，另一侧应立刻不认。
  await api(issuer, 'POST', '/api/auth/logout', { cookie });
  const afterLogout = await api(other, 'GET', '/api/auth/me', { cookie });
  check(`${label}：登出后 ${other} 立即失效（sessions 吊销跨栈生效）`,
    !afterLogout.json?.user, `user=${JSON.stringify(afterLogout.json?.user)}`);
}

console.log(`NODE=${NODE}  JAVA=${JAVA}  账号=${EMAIL}\n`);
await handoff('Node→Java', NODE, JAVA);
console.log();
await handoff('Java→Node', JAVA, NODE);

const failed = results.filter((r) => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length ? 1 : 0);
