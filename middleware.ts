// 全站安全中间件（v13.5 加强版）：
// 1) 安全响应头（CSP / HSTS / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy / COOP / CORP）
// 2) CSRF 防线：写操作（POST/PUT/PATCH/DELETE）校验 Origin 与 Host 同源
// 3) 全站 API 限流：每 IP 120 次/分钟（档位见 EDGE_API_LIMIT；登录等敏感接口另有更严的专项限流，
//    那一套落在 MySQL 的 rate_hits 里，两栈共用一本账）
import { NextResponse, type NextRequest } from "next/server";

function securityHeaders(): Record<string, string> {
  const isDev = process.env.NODE_ENV !== "production";
  // Next dev 模式需要 inline/eval 热更新；生产收紧为 self+inline（Next 注入样式与少量内联脚本）
  const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";
  const headers: Record<string, string> = {
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "X-DNS-Prefetch-Control": "off",
    // 跨域隔离：防 window.opener 劫持（COOP）、防跨源资源嵌入（CORP）、防 Flash/跨域策略文件
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
  };
  // HSTS：浏览器仅在 HTTPS 响应上记录（本地 http dev 自动无效，无副作用）
  if (process.env.NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }
  return headers;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// —— /api/* 一律由 Java 应答（P7f-2）——
// 这里原来读 JAVA_ROUTES，逐条决定"哪些前缀已经切过去、哪些还留在 Node"。那是渐进迁移的起重机，
// 而它的前提（Node 侧还有一套能应答的实现）已经随 app/api/** 一起删掉了。
// 现在这个开关做不到它承诺的事：清空 JAVA_ROUTES 不再是"整体回滚到 Node"，而是"所有 /api 请求
// 打到一堆不存在的路由上"。一个含义已经变掉的开关比没有开关更坏——它会让人以为还能回滚。
// 所以整条退役。回滚方式退回工程手段：revert 这次删除、重启，见 README「切流与回滚」。
// JAVA_BASE 没配时**明确 503**，不放行：页面渲染照旧走演示数据（那是产品承诺），
// 但任何一次交互都不该被 404 伪装成"这个接口不存在"。
const javaBase = (process.env.JAVA_BASE ?? "").replace(/\/+$/, "");

function wantsJava(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

// —— 全站 API 滑窗限流（middleware edge 内存桶；故意不进 MySQL，理由见 README 闸门 17 一节） ——
const g = globalThis as typeof globalThis & { __inkApiBuckets?: Map<string, number[]> };
const apiBuckets = (g.__inkApiBuckets ??= new Map<string, number[]>());
const API_LIMIT = (() => {
  // 120 次/分钟是给真实读者定的。抬档位的两种场景都在仓库自己身上：批量闸门一次跑上百条请求
  // 且全部来自同一个回环 IP（刷爆之后闸门看到的是 429，读起来和"两栈不一致"一模一样），
  // 以及出口共用一个公网 IP 的用户群。做成环境变量而不是改常量，是为了让"这台的档位"
  // 和"这台的行为"能分开验——对照实例照旧 120，抬档本身才不会变成免检。非法值回落默认。
  const raw = Number(process.env.EDGE_API_LIMIT ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 120;
})();
const API_WINDOW_MS = 60 * 1000; // 每分钟

function apiRateLimit(ip: string): { locked: boolean; retryAfterSec: number } {
  const now = Date.now();
  const key = `api:${ip}`;
  const arr = (apiBuckets.get(key) ?? []).filter((t) => now - t < API_WINDOW_MS);
  arr.push(now);
  apiBuckets.set(key, arr);
  // 桶清理：防止 Map 无限膨胀
  if (apiBuckets.size > 5000) {
    for (const [k, v] of apiBuckets) {
      if (v.every((t) => now - t >= API_WINDOW_MS)) apiBuckets.delete(k);
    }
  }
  return arr.length > API_LIMIT
    ? { locked: true, retryAfterSec: Math.ceil((API_WINDOW_MS - (now - arr[0])) / 1000) }
    : { locked: false, retryAfterSec: 0 };
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // v15.0：IP 提取。生产部署（nginx 反代后）必须设 TRUST_PROXY=1：
  // 此时取 x-real-ip（由 nginx 写入真实对端地址）或 XFF 链最后一跳，伪造头无效；
  // 未设 TRUST_PROXY（本地开发/直连）沿用 XFF 首段，行为与旧版一致。
  const trustProxy = process.env.TRUST_PROXY === "1";
  const xffList = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const realIp = (req.headers.get("x-real-ip") ?? "").trim();
  const ip = trustProxy
    ? realIp || xffList[xffList.length - 1] || "local"
    : xffList[0] || realIp || "local";

  // —— 全站 API 限流（页面渲染不限，只限 /api/*） ——
  if (pathname.startsWith("/api/")) {
    const rl = apiRateLimit(ip);
    if (rl.locked) {
      return NextResponse.json(
        { error: "请求过于频繁，请稍后再试" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }
  }

  // —— CSRF：写操作必须同源（Origin 存在时校验；同源/无 Origin 放行）——
  if (UNSAFE.has(req.method)) {
    const origin = req.headers.get("origin");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = "invalid";
      }
      if (originHost !== req.headers.get("host")) {
        return NextResponse.json(
          { error: "跨站请求被拒绝（CSRF 防护）" },
          { status: 403, headers: securityHeaders() }
        );
      }
    }
  }

  const res = NextResponse.next();
  if (wantsJava(pathname)) {
    if (!javaBase) {
      // 503 而不是放它去撞一个 404：404 说的是"没有这个接口"，真相是"这台没配后端"。
      const down = NextResponse.json(
        { error: "后端未配置：这台实例的 JAVA_BASE 是空的，渲染层已不再自己应答 /api/*" },
        { status: 503, headers: { ...securityHeaders(), "Cache-Control": "no-store" } }
      );
      down.headers.set("Retry-After", "30");
      return down;
    }
    const target = new URL(pathname + req.nextUrl.search, javaBase);
    // 把浏览器看到的 host/proto 显式传给 Java：Next 的 rewrite 会把请求的 Host 换成后端地址，
    // 于是 Java 自己算出来的 origin 是内网端口——导出的 Markdown 里每个链接都会变成
    // http://localhost:3101/... 这种用户不该看到的地址。这里用 set 覆盖（不是 append），
    // 客户端伪造的同名头到不了 Java。
    const forwarded = new Headers(req.headers);
    forwarded.set("x-forwarded-host", req.headers.get("host") ?? "");
    forwarded.set("x-forwarded-proto", req.nextUrl.protocol.replace(/:$/, ""));
    const proxied = NextResponse.rewrite(target, { request: { headers: forwarded } });
    for (const [k, v] of Object.entries(securityHeaders())) proxied.headers.set(k, v);
    return proxied;
  }
  for (const [k, v] of Object.entries(securityHeaders())) {
    res.headers.set(k, v);
  }
  // 静态资源长缓存且无需每次走中间件时也不设缓存头，这里只对页面生效
  if (pathname.startsWith("/_next/static")) {
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return res;
}

export const config = {
  // 全站生效；排除纯静态文件路径（Next 静态资产本身走 CDN 缓存即可）
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
