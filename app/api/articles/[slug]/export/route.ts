// GET /api/articles/[slug]/export — 导出文章 Markdown（.md 附件下载）
// 版式：规范 YAML frontmatter（值加引号防冒号破坏解析）+ 正文标题/署名行 + 出处页脚
// 可见性复用 getArticle：pending/rejected 仅作者与管理员可下载；
// 付费文（unlock_price>0）必须已解锁/作者/管理员，否则 402 防全文泄露（v15.0）
import { getArticle } from "@/lib/data";
import { getCurrentUser, isStaff } from "@/lib/auth";

/** JSON 字符串是合法 YAML 标量：防标题里的冒号/引号破坏 frontmatter 解析 */
const yq = (s: string) => JSON.stringify(s);

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getCurrentUser();
  const article = await getArticle(slug, {
    id: viewer?.id ?? null,
    privileged: isStaff(viewer?.role),
  });
  if (!article) return new Response("Not Found", { status: 404 });

  // 付费墙防线：未解锁的付费文不导出全文（游客/未解锁一律 402）
  const isOwn = viewer?.id != null && viewer.id === article.authorId;
  if (
    (article.unlockPrice ?? 0) > 0 &&
    !article.viewerUnlocked &&
    !isOwn &&
    !isStaff(viewer?.role)
  ) {
    return new Response("Payment Required", { status: 402 });
  }

  // v17.0：生产 next start 下 req.url.host 落 localhost，绝对链接一律优先取
  // NEXT_PUBLIC_SITE_URL（与 OAuth redirect_uri 同一铁律）
  const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
  const charCount = article.md.replace(/\s+/g, "").length;
  const readMinutes = Math.max(1, Math.round(charCount / 450));
  const today = new Date().toISOString().slice(0, 10);
  const url = `${origin}/article/${slug}`;

  // ---------- frontmatter（规范 YAML） ----------
  const fm = [
    "---",
    `title: ${yq(article.title)}`,
    `author: ${yq(article.author)}`,
    `date: ${yq(article.publishedAt)}`,
    ...(article.tags.length > 0
      ? [`tags:`, ...article.tags.map((t) => `  - ${yq(t)}`)]
      : [`tags: []`]),
    `source: ${yq("墨栈 InkStack")}`,
    `url: ${yq(url)}`,
    `words: ${charCount}`,
    `reading_minutes: ${readMinutes}`,
    "---",
    "",
    "",
  ].join("\n");

  // ---------- 正文：统一「H1 标题 → 署名行 → 内容」；自带 H1 则剥离避免重复 ----------
  const content = article.md.trim().replace(/\s+$/, "");
  const ownH1 = content.match(/^#\s+.+\r?\n/);
  const bodyMd = ownH1 ? content.slice(ownH1[0].length).replace(/^(\s+)/, "") : content;
  const heading = `# ${article.title}\n\n`;
  const byline = `> ${article.author} · ${article.publishedAt} · 约 ${readMinutes} 分钟读完 · [原文链接](${url})\n\n`;

  // ---------- 页脚 ----------
  const footer = `\n\n---\n\n*本文导自 [墨栈 InkStack](${origin}) · 导出于 ${today} · 原文：[${article.title}](${url})*\n`;

  const body = `${fm}${heading}${byline}${bodyMd}${footer}`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(slug)}.md"`,
      "Cache-Control": "no-store",
    },
  });
}
