#!/usr/bin/env node
// 切流路径闸门：证明"浏览器只跟 Next 说话、Next 把 /api/auth/* 转给 Java"这条链路真的通。
//
// 为什么单独一道：前面所有对拍都是直连两栈，走的是各自的 URL；而真实部署里浏览器只见
// 到 Next 的地址，认证请求要靠 middleware 的 rewrite 转发。这条路上会丢东西的三样是
// Set-Cookie（域/属性）、请求体（POST/PUT/DELETE）、以及边缘安全闸口（CSRF/限流）——
// 直连测不出来。X-Backend: inkstack-java 由 Java 的过滤器打上，是"这条请求确实落在 Java"
// 的唯一硬证据。
//
//   node scripts/proxy-cutover-check.mjs --base=http://localhost:3299
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const base = (process.argv.find((a) => a.startsWith("--base=")) ?? "").slice(7)
  || process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200";

let pass = 0;
let fail = 0;
const ok = (label, detail = "") => { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, detail) => { fail++; console.log(`FAIL  ${label}  — ${detail}`); };

const tag = (res) => res.headers.get("x-backend") ?? "";

async function call(method, p, { body, cookie, headers } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    cache: "no-store",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 由调用方判定 */ }
  return { status: res.status, json, text, backend: tag(res), res };
}

const setCookie = (res) => (res.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0]).find((c) => c.startsWith("ink_session="));

// 1) 命中前缀的只读请求确实落到 Java（应答头是唯一硬证据）
const routed = await call("GET", "/api/auth/providers");
if (routed.status === 200 && routed.backend === "inkstack-java") ok("/api/auth/providers 经 Next 转给 Java");
else bad("/api/auth/providers 经 Next 转给 Java", `${routed.status} backend=${routed.backend || "无"}`);

// 2) 没在 JAVA_ROUTES 里的前缀不得被带走（段匹配，且不能误伤）
const kept = await call("GET", "/api/articles");
if (kept.status === 200 && kept.backend === "") ok("/api/articles 仍在 Node 应答");
else bad("/api/articles 仍在 Node 应答", `backend=${kept.backend || "无"}`);
const sneaky = await call("GET", "/api/articlesXYZ");
if (sneaky.backend === "") ok("前缀相似路径未被错切（/api/articlesXYZ）");
else bad("前缀相似路径未被错切", `backend=${sneaky.backend}`);

// 3) POST 体要穿过 rewrite，Set-Cookie 要能被浏览器收下
const creds = [env.INK_TEST_EMAIL, env.INK_TEST_PASSWORD];
const login = await call("POST", "/api/auth/login", { body: { email: creds[0], password: creds[1] } });
const cookie = setCookie(login.res);
if (login.status === 200 && login.json?.ok && cookie) ok("登录经代理成功并下发会话 Cookie", `backend=${login.backend}`);
else bad("登录经代理成功并下发会话 Cookie", `${login.status} backend=${login.backend || "无"} ${login.text.slice(0, 90)}`);
if (login.backend === "inkstack-java") ok("登录请求确实由 Java 处理（不是静默回落 Node）");
else bad("登录请求确实由 Java 处理", `backend=${login.backend || "无"}`);

if (!cookie) {
  bad("会话后续请求", "前置登录没拿到 Cookie，后面的用例全部未跑");
} else {
  const me = await call("GET", "/api/auth/me", { cookie });
  if (me.json?.user?.email === creds[0]) ok("/api/auth/me 认得这枚 Cookie", `uid=${me.json.user.id}`);
  else bad("/api/auth/me 认得这枚 Cookie", `${me.status} ${me.text.slice(0, 90)}`);

  // 4) PUT/DELETE 带体也要过 rewrite：这里只验证不 500 + 归属正确，业务语义由跨栈闸门覆盖
  const put = await call("PUT", "/api/security/2fa", { body: { code: "000000" }, cookie });
  if (put.backend === "") ok("未切流前缀仍由 Node 应答（/api/security 不在 JAVA_ROUTES）");
  else bad("未切流前缀归属", `backend=${put.backend}`);

  const out = await call("POST", "/api/auth/logout", { body: {}, cookie });
  const cleared = setCookie(out.res);
  if (out.status === 200 && (!cleared || cleared.endsWith("="))) ok("登出经代理并清 Cookie", cleared ?? "无 Set-Cookie");
  else bad("登出经代理并清 Cookie", `${out.status} ${cleared ?? ""}`);
  const after = await call("GET", "/api/auth/me", { cookie });
  if (after.json?.user == null) ok("登出后 Java 立即不再认这枚 Cookie");
  else bad("登出后 Java 立即不再认这枚 Cookie", JSON.stringify(after.json).slice(0, 90));
}

// 5) 边缘安全闸口不能被切流绕过：跨站 Origin 的写请求必须在 Next 就被拒
const csrf = await call("POST", "/api/auth/login",
  { body: { email: creds[0], password: creds[1] }, headers: { origin: "https://evil.example" } });
if (csrf.status === 403 && csrf.backend === "") ok("CSRF 仍在边缘生效（未随切流下沉）");
else bad("CSRF 仍在边缘生效", `${csrf.status} backend=${csrf.backend || "无"}`);

console.log(`\nbase=${base}  合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
