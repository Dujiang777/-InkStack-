// RSS 订阅源：/feed.xml —— 博客平台标配，读者可用订阅器跟进更新
// 输出最新 30 篇公开文章（published + approved），XML 手工拼接 + 实体转义
import { listArticles } from "@/lib/data";

export const dynamic = "force-dynamic";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** v17.1：published_at 为 NULL 时勿输出 "Invalid Date"（订阅器会解析失败），退回当前时间 */
function pubDate(s: string): string {
  const d = s ? new Date(s) : null;
  return (d && Number.isFinite(d.getTime()) ? d : new Date()).toUTCString();
}

export async function GET(request: Request) {
  const site = `${new URL(request.url).protocol}//${new URL(request.url).host}`;
  const articles = (await listArticles()).slice(0, 30);

  const items = articles
    .map((a) => {
      const link = `${site}/article/${a.slug}`;
      const cats = (a.tags ?? []).map((t) => `<category>${esc(t)}</category>`).join("");
      return `    <item>
      <title>${esc(a.title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <dc:creator>${esc(a.author)}</dc:creator>
      <pubDate>${pubDate(a.publishedAt)}</pubDate>
      <description>${esc(a.summary)}</description>
      ${cats}
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>墨栈 InkStack</title>
    <link>${site}</link>
    <atom:link href="${site}/feed.xml" rel="self" type="application/rss+xml" />
    <description>墨水经济 · AI 分身 · 写作即泉涌——墨栈最新文章</description>
    <language>zh-CN</language>
    <generator>InkStack</generator>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
