import Link from "next/link";
import { listArticles } from "@/lib/data";
import { plainText } from "@/components/plain-text";

export const metadata = { title: "全部文章 · 墨栈 InkStack" };

// /article 索引页：全部在版文章（此前该路径是导航断链，直接访问 404）
export default async function ArticleIndexPage() {
  const all = await listArticles();

  return (
    <div className="tag-page">
      <header className="tag-hero">
        <p className="tag-kicker">INDEX · 全部文章</p>
        <h1 className="tag-title">
          在版文章 <small>{all.length} 篇 · 每篇都配了能对话的分身</small>
        </h1>
      </header>

      <ol className="tag-list">
        {all.map((a, i) => (
          <li key={a.slug}>
            <article className="card card-ink">
              <span className="idx" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              {a.tags[0] && (
                <Link className="tag-chip" href={`/tag/${encodeURIComponent(a.tags[0])}`}>
                  {a.tags[0]}
                </Link>
              )}
              {a.boostUntil && <span className="tag-chip hot">加热中</span>}
              {(a.tipTotal ?? 0) >= 50 && <span className="tag-chip tip">赏 {a.tipTotal}</span>}
              <h3>
                <Link href={`/article/${a.slug}`}>{a.title}</Link>
              </h3>
              <p className="card-meta">
                <Link className="meta-author" href={a.authorId ? `/author/${a.authorId}` : "#"}>
                  {a.author}
                </Link>
                <span>{a.publishedAt}</span>
                <span>阅读 {a.readCount.toLocaleString()}</span>
                <span>赞 {a.likeCount ?? 0}</span>
                <span>评 {a.commentCount}</span>
                <span>答 {a.agentQaCount}</span>
              </p>
              {a.summary && <p className="card-sum">{plainText(a.summary)}</p>}
            </article>
          </li>
        ))}
      </ol>
    </div>
  );
}
