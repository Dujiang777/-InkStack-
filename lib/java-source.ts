// Java 后端数据源客户端（渐进双轨期用）。
//
// 为什么需要它：28 个页面里有 27 个是 Server Component，直接 import lib/data.ts 在进程内打 MySQL。
// 后端换到 Java 后，这些页面的数据来源必须能改，但页面本身的 UI 与取数语义不想动。
// 所以 lib/data.ts 里每个已移植的函数开头加一句"这条路要不要走 Java"的分流，
// 由 DATA_VIA_JAVA 逐函数控制——页面一行都不用改，回滚也只是清环境变量。
//
// 三条硬规矩：
// 1) 必须转发 ink_session Cookie。Java 侧自己解析会话来决定付费墙与审核可见性，
//    不转发就会把已登录读者当游客，导致未购正文被当成有权读。
// 2) 必须 no-store。RSC 默认可能缓存取数结果，双轨期两侧行为要在每次渲染里现取现比。
// 3) 失败必须抛出，绝不静默回落到 Node SQL 或 demo 数据。静默回落会把"Java 挂了"
//    伪装成"站点正常"，而 listArticles 原有的 catch-降级-to-demo 正是这个坑。
import { cache } from "react";
import { cookies } from "next/headers";
import type { ArticleRow } from "./data";
import type { SessionUser } from "./auth";

const TIMEOUT_MS = 8_000;

function javaBase(): string {
  const base = (process.env.JAVA_BASE ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("DATA_VIA_JAVA 已启用但 JAVA_BASE 未配置");
  return base;
}

/** 已分流到 Java 的函数名；`*` 表示全部已移植的都走 Java，空值表示一律走 Node。 */
export function viaJava(fn: string): boolean {
  const raw = (process.env.DATA_VIA_JAVA ?? "").trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(fn);
}

async function forwardCookie(): Promise<string> {
  try {
    const jar = await cookies();
    return jar.get("ink_session")?.value ?? "";
  } catch {
    // 非请求上下文（静态生成、脚本、sitemap）拿不到 Cookie：按游客身份取公开数据。
    return "";
  }
}

async function ask<T>(path: string): Promise<T> {
  const cookie = await forwardCookie();
  const res = await fetch(`${javaBase()}${path}`, {
    headers: { cookie, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e: unknown) => {
    throw new Error(`Java 数据源不可达 ${path}：${e instanceof Error ? e.message : String(e)}`);
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Java 数据源返回非 JSON（${res.status}）${path}：${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const err = (json as { error?: string })?.error ?? text.slice(0, 160);
    throw new Error(`Java 数据源 ${res.status} ${path}：${err}`);
  }
  return json as T;
}

export async function remoteListArticles(): Promise<ArticleRow[]> {
  const body = await ask<{ articles: ArticleRow[] }>("/api/articles");
  return body.articles;
}

/**
 * Java 的详情接口在服务端一次判清付费墙：有权读回全文、无权读回 SQL 层截断的 6 行。
 * 因此 Node 版"先取截断再取全文"的第二次调用在这里天然合并成同一结果——
 * includeMd 对 Java 路径不再有意义，两个调用返回同一个对象（同一次渲染内由 cache() 合流）。
 */
export const remoteGetArticle = cache(async (slug: string): Promise<ArticleRow | null> => {
  try {
    const body = await ask<{ article: ArticleRow }>(`/api/articles/${encodeURIComponent(slug)}`);
    return body.article;
  } catch (e) {
    // 404 是正常语义（文章不存在 / 对当前身份不可见），页面据此走 notFound()。
    if (e instanceof Error && e.message.includes("404")) return null;
    throw e;
  }
});

export async function remoteMe(): Promise<{ user: SessionUser | null }> {
  return ask<{ user: SessionUser | null }>("/api/auth/me");
}
