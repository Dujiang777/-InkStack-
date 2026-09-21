// sitemap.xml：Next 约定式生成 —— 首页 + 全部公开文章 + 标签页
import type { MetadataRoute } from "next";
import { listArticles } from "@/lib/data";

export const dynamic = "force-dynamic";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100";

/** 安全日期：仅接受可解析的发布时间，其余返回 undefined
 *  （v17.1：published_at 为 NULL 的历史文章曾让 new Date().toISOString() 抛
 *   RangeError: Invalid time value，导致整个 /sitemap.xml 500） */
function safeDate(s: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const articles = await listArticles();

  const tags = new Set<string>();
  for (const a of articles) for (const t of a.tags) tags.add(t);

  return [
    { url: siteUrl, changeFrequency: "daily", priority: 1 },
    { url: `${siteUrl}/search`, changeFrequency: "weekly", priority: 0.3 },
    ...[...tags].map((t) => ({
      url: `${siteUrl}/tag/${encodeURIComponent(t)}`,
      changeFrequency: "daily" as const,
      priority: 0.5,
    })),
    ...articles.map((a) => ({
      url: `${siteUrl}/article/${a.slug}`,
      lastModified: safeDate(a.publishedAt),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
