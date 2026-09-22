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
//                                      [--keep=/api/articles] [--money] [--community]
//
// --keep  声明"这一次必须仍由 Node 应答"的前缀：切流范围变了，这个负断言也要跟着换，
//         否则"未切流"的断言会在切到 /api/articles 那一档时自己打自己。
// --money 追加资金写链路经代理的证据（P4）。只挑不改账的用例：
//         已签到用户的 POST /api/checkin → already；非法档位的 POST tip → 400。
// --community 追加社区互动经代理的证据（P5）：未登录/参数非法/只读三类，同样一笔数据都不改。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const base = arg("base", process.env.PARITY_NODE || env.PARITY_NODE || "http://localhost:3200");
const KEEP_PREFIX = arg("keep", "/api/articles");
const MONEY = process.argv.includes("--money");
const COMMUNITY = process.argv.includes("--community");

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
const kept = await call("GET", KEEP_PREFIX);
if (kept.backend === "") ok(`${KEEP_PREFIX} 仍在 Node 应答`);
else bad(`${KEEP_PREFIX} 仍在 Node 应答`, `backend=${kept.backend}`);
const sneaky = await call("GET", `${KEEP_PREFIX}XYZ`);
if (sneaky.backend === "") ok(`前缀相似路径未被错开（${KEEP_PREFIX}XYZ）`);
else bad("前缀相似路径未被错开", `backend=${sneaky.backend}`);

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

  // 4) 未切流前缀上的写不得被段通配顺走：/api/articles/*/unlock 只该带走 unlock 那一支
  const keepWrite = await call("PUT", `${KEEP_PREFIX}/__cutover_probe__`, { body: {}, cookie });
  if (keepWrite.backend === "") ok(`未切流前缀的写仍由 Node 应答（${KEEP_PREFIX}/*）`, `status=${keepWrite.status}`);
  else bad("未切流前缀的写归属", `backend=${keepWrite.backend}`);

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

// 6) P4 资金写链路经代理：只挑"不改账"的入口——未登录、已领过、档位非法
if (MONEY) {
  const login2 = await call("POST", "/api/auth/login", { body: { email: creds[0], password: creds[1] } });
  const c2 = setCookie(login2.res);
  const probes = [
    ["未登录解锁 → 401", "POST", "/api/articles/qian-duan-xing-neng-you-hua-qing-dan/unlock", {}, undefined, 401],
    ["签到状态查询 → 200", "GET", "/api/checkin", undefined, c2, 200],
    ["徽章领取（未集齐）→ 400", "POST", "/api/me/badge-claim", {}, c2, 400],
    ["非法打赏档位 → 400", "POST", "/api/articles/bo-20260911-1/tip", { amount: 7 }, c2, 400],
    ["收银台套餐 → 200", "GET", "/api/topup/orders", undefined, undefined, 200],
  ];
  for (const [label, method, p, body, cookie, want] of probes) {
    const r = await call(method, p, { body, cookie });
    const shape = p === "/api/checkin" ? typeof r.json?.checkedInToday === "boolean"
      : p === "/api/topup/orders" ? Array.isArray(r.json?.packs)
      : p.endsWith("/tip") ? r.json?.error === "打赏档位须为 10 或 50 点墨"
      : r.json?.error !== undefined;
    if (r.status === want && r.backend === "inkstack-java" && shape) ok(`经代理的${label}`, `backend=${r.backend}`);
    else bad(`经代理的${label}`, `${r.status}/${want} backend=${r.backend || "无"} body=${r.text.slice(0, 70)}`);
  }
  // 资金写同样必须吃边缘 CSRF：这条若被放过，等于给"跨站刷墨"开门
  const moneyCsrf = await call("POST", "/api/articles/bo-20260911-1/tip",
    { body: { amount: 10 }, cookie: c2, headers: { origin: "https://evil.example" } });
  if (moneyCsrf.status === 403 && moneyCsrf.backend === "") ok("资金写请求的 CSRF 也在边缘拦住");
  else bad("资金写请求的 CSRF 也在边缘拦住", `${moneyCsrf.status} backend=${moneyCsrf.backend || "无"}`);
}

// 7) P5 社区互动经代理：同样只挑"不改数据"的入口——未登录、参数非法、只读
if (COMMUNITY) {
  const login3 = await call("POST", "/api/auth/login", { body: { email: creds[0], password: creds[1] } });
  const c3 = setCookie(login3.res);
  const probes = [
    ["未登录点赞评论 → 401", "POST", "/api/comments/1/like", undefined, undefined, 401, "登录后才能点赞评论"],
    ["非数字评论 id → 400", "POST", "/api/comments/abc/like", undefined, c3, 400, "参数无效"],
    ["未登录关注 → 401", "POST", "/api/users/1/follow", undefined, undefined, 401, "请先登录"],
    ["未登录收藏 → 401", "POST", "/api/articles/bo-20260911-1/bookmark", undefined, undefined, 401, "登录后才能收藏"],
    ["未登录举报 → 401", "POST", "/api/articles/bo-20260911-1/report", { reason: "经代理探针" }, undefined, 401, "登录后才能举报"],
    ["未登录读站内信 → 401", "GET", "/api/notifications", undefined, undefined, 401, "请先登录"],
  ];
  for (const [label, method, p, body, cookie, want, text] of probes) {
    const r = await call(method, p, { body, cookie });
    if (r.status === want && r.backend === "inkstack-java" && r.json?.error === text) {
      ok(`经代理的${label}`, `backend=${r.backend}`);
    } else {
      bad(`经代理的${label}`, `${r.status}/${want} backend=${r.backend || "无"} body=${r.text.slice(0, 70)}`);
    }
  }
  const notices = await call("GET", "/api/notifications", { cookie: c3 });
  if (notices.status === 200 && notices.backend === "inkstack-java"
    && Array.isArray(notices.json?.notifications) && typeof notices.json?.unread === "number") {
    ok("经代理读站内信回列表与未读数", `unread=${notices.json?.unread}`);
  } else {
    bad("经代理读站内信回列表与未读数", `${notices.status} backend=${notices.backend || "无"}`);
  }
  const likeCsrf = await call("POST", "/api/articles/bo-20260911-1/like",
    { cookie: c3, headers: { origin: "https://evil.example" } });
  if (likeCsrf.status === 403 && likeCsrf.backend === "") ok("社区写请求的 CSRF 也在边缘拦住");
  else bad("社区写请求的 CSRF 也在边缘拦住", `${likeCsrf.status} backend=${likeCsrf.backend || "无"}`);
}

console.log(`\nbase=${base}  合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
