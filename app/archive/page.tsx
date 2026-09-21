import Link from "next/link";
import { listArticles } from "@/lib/data";

// 归档页：全部公开文章按月份分组的时间线（刊期式）
export const metadata = {
  title: "归档 · 全部文章 — 墨栈 InkStack",
  description: "墨栈全部公开文章，按月归档。",
};

export default async function ArchivePage() {
  const articles = await listArticles();

  const months = new Map<string, typeof articles>();
  for (const a of articles) {
    // 迁移/导入的文章可能存了字符串 "null"，一并归入早期
    const raw = a.publishedAt && a.publishedAt !== "null" ? a.publishedAt : "";
    const key = raw.slice(0, 7) || "早期";
    const arr = months.get(key) ?? [];
    arr.push(a);
    months.set(key, arr);
  }
  const groups = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const zh = (ym: string) =>
    ym === "早期"
      ? "早期刊文"
      : `${Number(ym.slice(5, 7))} 月 · ${ym.slice(0, 4)}`;

  return (
    <div className="archive-page">
      <header className="archive-hero">
        <p className="tag-kicker">ARCHIVE · 过刊库</p>
        <h1 className="tag-title">
          归档
          <small>
            共 {articles.length} 篇 · {groups.length} 个刊期
          </small>
        </h1>
      </header>

      {groups.map(([ym, list]) => (
        <section className="archive-group" key={ym}>
          <h2 className="archive-month">
            {zh(ym)}
            <span>{list.length} 篇</span>
          </h2>
          <ol className="archive-list">
            {list.map((a) => (
              <li key={a.slug}>
                <span className={`ar-date${a.publishedAt && a.publishedAt !== "null" ? "" : " is-early"}`}>
                  {a.publishedAt && a.publishedAt !== "null" ? a.publishedAt : "早期"}
                </span>
                <Link className="ar-title" href={`/article/${a.slug}`}>
                  {a.title}
                </Link>
                <span className="ar-meta">
                  {a.author} · {a.readCount.toLocaleString()} 阅
                  {(a.tipTotal ?? 0) > 0 ? ` · 墨 ${(a.tipTotal ?? 0).toLocaleString()}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
