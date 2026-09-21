// 迁移工具核心解析（零依赖）：RSS2.0 / Atom 抓取解析 + Markdown 文件解析 + HTML 消毒
// 设计取舍：
// - RSS 内容是外部 HTML，入库前必须消毒（去 script/iframe/on* 属性/javascript: 协议）
// - Markdown 文件是登录博主自己的内容，原始保留（代码块里的 <script> 会被 marked 转义，无注入风险）
// - P1 换 DOMPurify 做完整白名单消毒

export type ImportItem = {
  title: string;
  md: string;
  summary: string;
  publishedAt: Date | null;
};

/** 消毒外部 HTML：去除可执行/可嵌入内容 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?(<\/iframe>|\/>)/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

function tagText(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name.replace(/:/g, "\\:")}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name.replace(/:/g, "\\:")}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1].trim();
  // HTML 实体基础解码（标题里常见）
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 去掉 Markdown 标记，取纯文本用于摘要 */
export function stripMd(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")      // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // 链接保留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")        // 标题符
    .replace(/[*_`~]{1,3}/g, "")               // 强调/代码符
    .replace(/^\s*[-+>]\s+/gm, "")             // 列表/引用符
    .replace(/\s+/g, " ")
    .trim();
}

function firstParagraph(md: string): string {
  const lines = md.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^#{1,6}\s/.test(t) || /^!\[/.test(t) || /^\s*[-*|`]/.test(t)) continue;
    return stripMd(t);
  }
  return "";
}

/** 解析 RSS2.0 / Atom 订阅源（最多取前 20 条） */
export function parseFeed(xml: string): ImportItem[] {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  const items: ImportItem[] = [];
  for (const block of blocks.slice(0, 20)) {
    const rawTitle = tagText(block, "title");
    if (!rawTitle) continue;
    const content =
      tagText(block, "content:encoded") ||
      tagText(block, "content") ||
      tagText(block, "description") ||
      tagText(block, "summary");
    const dateStr = tagText(block, "pubDate") || tagText(block, "published") || tagText(block, "updated");
    const date = dateStr ? new Date(dateStr) : null;
    const md = sanitizeHtml(content);
    items.push({
      title: stripMd(rawTitle).slice(0, 200),
      md,
      summary: stripMd(content).slice(0, 180),
      publishedAt: date && !isNaN(date.getTime()) ? date : null,
    });
  }
  return items;
}

/** 解析单个 Markdown 文件：标题取首个一级标题，否则用文件名 */
export function parseMarkdownFile(text: string, filename: string): ImportItem {
  const titleMatch = text.match(/^\s*#\s+(.+?)\s*$/m);
  const fallbackTitle = filename.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ").trim();
  const title = (titleMatch ? titleMatch[1] : fallbackTitle || "未命名文章").slice(0, 200);
  return {
    title,
    md: text.trim(),
    summary: firstParagraph(text).slice(0, 180),
    publishedAt: null,
  };
}

/** 生成 URL 安全 slug（中文标题回退到日期编号） */
export function makeSlug(title: string, seq: number): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return base || `bo-${stamp}-${seq}`;
}
