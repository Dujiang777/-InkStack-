#!/usr/bin/env node
// 第二十道闸门：演示模式（JAVA_BASE 为空）必须"渲染得出来"，而不是把站点变成一堆 500。
//
// 为什么要单独有一道——这个洞是 P7f-1f-b 我自己交出去的，值得写下来：
// 那天把渲染层最后四条进程内 MySQL 迁给 Java，其中会话那条写成
//   export const remoteCurrentUser = cache(async () => { const body = await ask(...); ... });
// 少了一句 `if (!javaReady()) return null`。配了 JAVA_BASE 的实例上它一字不错，所有闸门全绿；
// 而"clone 下来先跑起来看界面"这条产品承诺走的是**没配 JAVA_BASE** 的那一档，
// javaBase() 直接抛，于是每一个页面都 500。这个分支从来没有实例在跑，所以从来没有闸门看过它一眼。
// 结论：**一条判据若它的前提（"JAVA_BASE 非空"）被所有在跑的实例共享，那它就没在守另一半。**
//
// 判据分三格，前两格是前提：
//   §0 证明"我打到的这个实例真的在演示模式"——否则后面每一条绿都不说明任何事。
//      证据是 /api/* 必须回 503 且 error 说明"后端未配置"：404 说明路由还在（不是这一档），
//      带 x-backend 的应答说明 JAVA_BASE 其实生效了（那是另一档）。
//   §1 每个页面（含需要身份的页在游客态）必须 200 或 3xx，绝不 500；
//      且页面上不得出现取数异常的文本（javaBase() 抛出的那句原文、"数据源不可达"、
//      "ECONNREFUSED"…）——有人在演示模式下抛了又没被边界兜住时，Next 会把错误文本
//      铺进页面，那比 500 更难发现。⚠ 这里匹配的是**那句抛出的话**而不是裸的 "JAVA_BASE"：
//      运营台页眉上有一句"演示数据 · 未配置 JAVA_BASE"是**产品故意说给人看的**，
//      拿关键词当判据会把那条诚实的提示一起判成违规（第一版就红在这里）。
//   §2 渲染出来的必须是 lib/demo-data.ts 的内容（现读该文件取标记，不写死字符串）。
//
//   node scripts/demo-mode-check.mjs            # 自己起一台 3399 的临时实例，跑完即停
//
// 反证（跑过，不是设想）：把 `remoteCurrentUser` 里那句 `if (!javaReady()) return null` 删掉，
// 再跑这一道 → **29 项里 22 项红**（每个页面 500，且 §1 的"漏出异常文本"逐条命中
// "JAVA_BASE 未配置"）。也就是说这一道不是"补一条判据看着像那回事"，它一红就是满屏红。
// 另一个方向也验过：第一版的关键词表里有裸的 "JAVA_BASE"，于是**正常状态**下 /admin 就红一条
// （页眉那句"演示数据 · 未配置 JAVA_BASE"是产品写的诚实提示）——判据太宽和判据太窄一样会骗人。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.DEMO_PORT || 3399);
const BASE = `http://localhost:${PORT}`;
const DIST = ".next-demomode";
const BOOT_MS = 120_000;

let pass = 0;
let fail = 0;
function ok(label, detail = "") {
  pass++;
  console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
}
function bad(label, detail) {
  fail++;
  console.log(`FAIL  ${label}  — ${detail}`);
}
function check(cond, label, detail) {
  if (cond) ok(label, detail); else bad(label, detail);
  return cond;
}

/** 演示模式那一档的实例：只把 JAVA_BASE 抹空，其余环境照抄（数据库、Cookie 域都要在）。 */
function boot() {
  fs.rmSync(path.join(root, DIST), { recursive: true, force: true });
  const child = spawn(process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "-p", String(PORT)], {
      cwd: root,
      env: { ...process.env, JAVA_BASE: "", NEXT_DIST_DIR: DIST, NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  child.on("exit", (code) => log.push(`\n（子进程已退出 code=${code}）\n`));
  const stop = () => {
    try {
      // Windows 下 child.kill 只杀得到 next 这个外壳，端口由它的子进程占着；/T 连树一起停。
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else child.kill("SIGKILL");
    } catch { /* 已经停了 */ }
  };
  return { child, stop, tail: () => log.join("").split(/\r?\n/).slice(-14).join("\n") };
}

async function waitReady(tail) {
  const deadline = Date.now() + BOOT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/", { cache: "no-store", redirect: "manual" });
      await r.text();
      return true;                       // 任何应答（含 500）都说明服务在听了
    } catch {
      if (tail().includes("已退出")) return false;
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  return false;
}

async function get(p) {
  const res = await fetch(BASE + p, {
    headers: { "user-agent": "inkstack-demo-check" }, cache: "no-store", redirect: "manual",
  });
  const text = res.status >= 300 && res.status < 400 ? "" : await res.text();
  return { status: res.status, text, backend: res.headers.get("x-backend") ?? "" };
}

/** 从源码里现取演示数据的标记，别把字符串抄进脚本——抄进来的那份会和数据一起过期。 */
function demoMarkers() {
  const src = fs.readFileSync(path.join(root, "lib", "demo-data.ts"), "utf8");
  const slug = (src.match(/slug:\s*"([^"]+)"/) ?? [])[1] ?? "";
  const title = (src.match(/title:\s*"([^"]+)"/) ?? [])[1] ?? "";
  const tag = (src.match(/tags:\s*\[\s*"([^"]+)"/) ?? [])[1] ?? "";
  return { slug, title, tag };
}

const LEAK = ["JAVA_BASE 未配置", "数据源不可达", "ECONNREFUSED", "ER_NO_SUCH_TABLE",
  "Cannot find module", "Internal Server Error"];

const { stop, tail } = boot();
try {
  if (!await waitReady(tail)) {
    bad("临时实例起得来", `未能在 ${BOOT_MS / 1000}s 内应答 ${BASE}/\n${tail()}`);
    throw new Error("boot failed");
  }
  ok("临时实例起得来", `${BASE}（NEXT_DIST_DIR=${DIST}，JAVA_BASE 已抹空）`);

  // —— §0 前提：这一档真的是"没配后端" ——
  const api = await get("/api/articles?limit=1");
  const inDemo = api.status === 503 && !api.backend && /后端未配置/.test(api.text);
  check(inDemo, "§0 /api/* 由中间件挡在 503，说明这台真的没有后端",
    inDemo ? "503 + Retry-After，且没有转发到任何 Java"
      : `实际 ${api.status}、x-backend=${api.backend || "（无）"}、体=${api.text.slice(0, 120)}`);
  const renderStillOn = await get("/");
  check(renderStillOn.status === 200, "§0 抹掉后端只影响 /api，渲染层照常应答", `首页 ${renderStillOn.status}`);

  const demo = demoMarkers();
  check(Boolean(demo.slug && demo.title), "§0 演示数据标记取到了", JSON.stringify(demo));

  // —— §1 每个页面都渲染得出来 ——
  const PAGES = [
    "/", "/hot", "/archive", "/series", "/weekly", "/login", "/import", "/notifications",
    `/search?q=${encodeURIComponent("Java")}`, `/tag/${encodeURIComponent(demo.tag || "Java")}`,
    `/article/${demo.slug}`, "/feed.xml", "/sitemap.xml", "/robots.txt",
    // 需要身份的四个：游客态必须"要么正常渲染要么跳登录"，不许 500
    "/me", "/points", "/security", "/studio", "/study", "/admin", "/random",
  ];
  for (const p of PAGES) {
    const r = await get(p);
    const rendered = r.status === 200 || (r.status >= 300 && r.status < 400);
    const leak = LEAK.find((w) => r.text.includes(w));
    check(rendered && !leak, `§1 ${p} 渲染得出来`,
      rendered && !leak ? `${r.status}` : `${r.status}${leak ? ` 且页面上漏出「${leak}」` : ""}`);
  }

  // —— §2 渲染出来的是演示数据，不是"看起来正常" ——
  const home = await get("/");
  check(home.text.includes(demo.title), "§2 首页列的是 demo-data 里那篇的头一篇",
    home.text.includes(demo.title) ? demo.title.slice(0, 30) : "没找到标题——页面可能空列表或读到了别处");
  const detail = await get(`/article/${demo.slug}`);
  check(detail.status === 200 && detail.text.includes(demo.title),
    "§2 演示文章的详情页也渲染得出来", `${detail.status}`);
  // 这一档没有会话可解，"我是谁"只能是游客。闸门 4 的 §5c 守的是反方向（已登录却不认人），
  // 这里守的是"根本没得登录时不许假装认得谁"——两个方向合起来才钉住 remoteCurrentUser 的返回值。
  const points = await get("/points");
  check(points.status === 200 && /查看你的墨仓/.test(points.text) && !/退出登录/.test(points.text),
    "§2 身份页在游客态走的是游客分支", `${points.status}`);
  // 演示模式最坏的事不是渲染兜底假数，而是**兜底假数没说自己假**：运营台八格全是数字，
  // 读者无从分辨。那句 badge 是唯一一处把"这是演示数据"说给看的人听的地方。
  const admin = await get("/admin");
  check(admin.status === 200 && /演示数据/.test(admin.text),
    "§2 运营台必须自报「这是演示数据」，不许把兜底假数摆成实时数据", `${admin.status}`);
} catch (e) {
  if (String(e.message) !== "boot failed") bad("闸门自身出错", String(e.stack ?? e));
} finally {
  stop();
}

console.log(`\n合计 ${pass + fail} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
