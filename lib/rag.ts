// RAG 检索层（P0）：MySQL ngram 全文检索博主文章 → 抽取相关段落
// P1 升级点：换成向量召回（pgvector / 独立向量库），本模块签名不变
// v17.2：检索口径与付费墙对齐——未解锁的付费文不进入检索语料，
//        否则登录用户花 5 点墨问一句，就能让 AI 分身复述付费正文（绕过 unlock）。
import type { Pool } from "mysql2/promise";

export type Snippet = { title: string; text: string };

export async function retrieveSnippets(
  pool: Pool,
  question: string,
  viewerId?: number | null
): Promise<Snippet[]> {
  const me = Number(viewerId) > 0 ? Number(viewerId) : 0;
  try {
    const [rows] = await pool.query(
      `SELECT title, md_content AS md
       FROM articles
       WHERE status = 'published'
         AND review_status = 'approved'
         AND MATCH(title, md_content) AGAINST(? IN NATURAL LANGUAGE MODE)
         AND (IFNULL(unlock_price,0) = 0
              OR author_id = ?
              OR EXISTS (SELECT 1 FROM article_purchases p
                          WHERE p.article_id = articles.id AND p.user_id = ?))
       LIMIT 3`,
      [question, me, me]
    );
    const out: Snippet[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      const md = String(r.md ?? "");
      // 粗排：按空行切段，取包含问题关键词或长度合适的段落，每篇最多 2 段
      const paras = md
        .split(/\n{2,}/)
        .map((p) => p.replace(/[#>*`\[\]\-]/g, "").trim())
        .filter((p) => p.length > 30);
      const kw = question.replace(/[？?！!，。、\s]/g, "");
      const hit = paras.filter((p) => [...kw].some((ch) => p.includes(ch))).slice(0, 2);
      for (const p of (hit.length ? hit : paras.slice(0, 1))) {
        out.push({ title: String(r.title), text: p.slice(0, 300) });
      }
    }
    return out.slice(0, 5);
  } catch {
    return [];
  }
}
