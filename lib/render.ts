// Markdown 渲染管线：marked + 自定义 renderer
// - 代码块：轻量高亮（lib/highlight）+ 语言标签 + 行号
// - 链接：白名单域名正常渲染；其余加「待审核」标记（不可点击）
// - 图片：figure 包裹 + 载入渐显
import { marked, type Tokens, type Token } from "marked";
import DOMPurify from "isomorphic-dompurify";
import { highlightCode } from "./highlight";
import { allowedDomains, extractDomain } from "./link-policy";

let cachedDomains: Set<string> | null = null;
let cachedAt = 0;
const DOMAIN_CACHE_TTL = 60_000; // 60s：admin 审核通过后最迟 1 分钟生效

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function renderMarkdown(md: string): Promise<string> {
  if (!cachedDomains || Date.now() - cachedAt > DOMAIN_CACHE_TTL) {
    cachedDomains = await allowedDomains();
    cachedAt = Date.now();
  }
  const domains = cachedDomains;

  const renderer = {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? "").trim().split(/\s+/)[0] || "text";
      const colored = language === "text" ? esc(text.replace(/\n$/, "")) : highlightCode(text, language);
      return `<figure class="code-block" data-lang="${esc(language)}">
<div class="code-win"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="code-lang">${esc(language)}</span></div>
<pre><code>${colored}</code></pre>
</figure>`;
    },
    link(
      this: { parser: { parseInline: (tokens: Token[]) => string } },
      { href, title, tokens }: Tokens.Link
    ): string {
      const text = this.parser.parseInline(tokens as Token[]);
      const domain = extractDomain(href ?? "");
      if (domain && domains.has(domain)) {
        return `<a href="${esc(href ?? "")}" title="${esc(title ?? "")}" target="_blank" rel="noopener noreferrer nofollow" class="ok-link">${text}</a>`;
      }
      // 待审核：显示原文与域名，不可点击
      return `<span class="pending-link" title="外链待审核：${esc(domain)}">${text}<i>待审核</i></span>`;
    },
    image({ href, title, text }: Tokens.Image): string {
      const alt = esc(text ?? "");
      return `<figure class="article-figure"><img src="${esc(href ?? "")}" alt="${alt}" title="${esc(title ?? "")}" loading="lazy" decoding="async" />${alt ? `<figcaption>${alt}</figcaption>` : ""}</figure>`;
    },
  };
  marked.use({ renderer });
  const raw = (await marked.parse(md)) as string;
  // 出口统一消毒（P1 防线）：即便 renderer 或上游有漏洞，危险标签/属性/协议在此被剥除。
  // 白名单保持宽松以兼容自定义 renderer 的产物（figure/code-win/a[target]/data-lang/id 锚点等），
  // 但 javascript:/data: 协议、on* 事件属性、script/iframe/style 等一律由 DOMPurify 拦截。
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel", "loading", "decoding", "data-lang"],
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "iframe", "embed", "object"],
    FORBID_ATTR: ["srcset"],
  });
}

/* ---------- 目录：给 h2/h3 注入锚点 id 并提取目录树 ---------- */

export type TocItem = { id: string; text: string; level: number };

/** 渲染后的 HTML → 注入 id 后的 HTML + 目录（供侧栏目录卡使用） */
export function withHeadingIds(html: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (m, lvl: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (!text) return m;
    const id = `toc-${toc.length + 1}`;
    toc.push({ id, text, level: Number(lvl) });
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });
  return { html: out, toc };
}
