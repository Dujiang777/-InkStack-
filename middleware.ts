// 全站安全中间件（v13.5 加强版）：
// 1) 安全响应头（CSP / HSTS / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy / COOP / CORP）
// 2) CSRF 防线：写操作（POST/PUT/PATCH/DELETE）校验 Origin 与 Host 同源
// 3) 全站 API 限流：每 IP 120 次/分钟（防爬/防滥用第一道闸；登录等敏感接口另有更严的专项限流）
import { NextResponse, type NextRequest } from "next/server";
import { javaDataSource } from "./lib/data-mode";

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

// —— 渐进双轨切流：命中前缀的 /api/* 由 Java 后端应答，其余仍走 Node ——
// 放在限流与 CSRF 之后：安全闸口始终在边缘生效，与"谁来处理这条请求"解耦。
// JAVA_ROUTES 逗号分隔，每项是一条路径模式：
//   · 普通前缀按**段**匹配（/api/articles 不会顺带命中 /api/articlesXYZ，但会命中 /api/articles/xxx）；
//   · 段内的 * 匹配**恰好一段**，用于"同一资源下只有部分子路由已迁完"的场景，
//     如 /api/articles/*/unlock —— 文章改删 / 点赞 / 举报还在 Node 时，
//     只写 /api/articles 会把它们一起带走（Java 没这些路由 → 405，页面当场坏）。
//   · 单独的 * 表示全量切流；清空 JAVA_ROUTES 即整体回滚到 Node，不需要改任何代码。
const javaBase = (process.env.JAVA_BASE ?? "").replace(/\/+$/, "");
const javaRoutes = (process.env.JAVA_ROUTES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function toMatcher(entry: string): RegExp | null {
  if (entry === "*") return null; // 全量切流，由调用方直接放行
  const source = entry
    .split("/")
    .map((seg) => (seg === "*" ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}(?:/|$)`);
}

const javaMatchers = javaRoutes.map(toMatcher);

function routedToJava(pathname: string): boolean {
  if (!javaBase || !pathname.startsWith("/api/")) return false;
  return javaMatchers.some((m) => m === null || m.test(pathname));
}

// —— 全站 API 滑窗限流（middleware edge 内存桶；多实例部署换 Redis） ——
const g = globalThis as typeof globalThis & { __inkApiBuckets?: Map<string, number[]> };
const apiBuckets = (g.__inkApiBuckets ??= new Map<string, number[]>());
const API_LIMIT = 120; // 次
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
  // 页面取数走哪一路，得能从外面看见。P7d 把 DATA_VIA_JAVA 的默认从"关"翻成"配了 JAVA_BASE 就开"，
  // 于是"这一台实例到底走哪条路"变成一个会随环境悄悄改掉的事实——双轨对拍最怕的就是
  // 自以为在比两条路、实际在比同一条。这里与 lib/java-source 读同一个判据，报的就是页面真会走的路。
  res.headers.set("x-data-source", javaDataSource() ? "java" : "node");
  if (routedToJava(pathname)) {
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
    // 切到 Java 的应答也要带这个头：它报的是**本 Next 进程**的页面取数模式，与 x-backend
    // （这一发接口由谁应答）是两件事。只在不切的那条分支上设，会让"没头"同时意味着
    // "走了 Java 接口"和"这台实例没这个信息"，读的人分不清。
    proxied.headers.set("x-data-source", javaDataSource() ? "java" : "node");
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
