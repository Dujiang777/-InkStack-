import Link from "next/link";
import type { Metadata } from "next";
import { listByTag, listArticles } from "@/lib/data";
import { plainText } from "@/components/plain-text";

// 标签聚合页：/tag/[tag] —— 点击任意标签芯片进入，按发布时间倒序
// 版式：话题卷宗（页头题名 + 话题印 + 卷宗数据签 / 墨轴挂章条目 / 卷末收口 / 脚注带）
const CN_NUM = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tag: string }>;
}): Promise<Metadata> {
  const { tag: raw } = await params;
  const tag = decodeURIComponent(raw);
  return {
    title: `#${tag} · 话题文章 — 墨栈 InkStack`,
    description: `墨栈上与「${tag}」相关的全部文章。`,
  };
}

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag: raw } = await params;
  const tag = decodeURIComponent(raw);
  const articles = await listByTag(tag);

  // 相关话题：从近期文章里收同页出现、排除当前标签的相邻标签
  const pool = (await listArticles()).slice(0, 30);
  const related = new Map<string, number>();
  for (const a of pool) {
    if (a.tags.includes(tag)) {
      for (const t of a.tags) {
        if (t !== tag) related.set(t, (related.get(t) ?? 0) + 1);
      }
    }
  }
  const relatedTags = [...related.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // 展示层聚合：卷宗体量直接由已加载的列表求和，不引入新的查询或数据结构
  const totalRead = articles.reduce((s, a) => s + (a.readCount ?? 0), 0);
  const totalLike = articles.reduce((s, a) => s + (a.likeCount ?? 0), 0);
  const totalComment = articles.reduce((s, a) => s + (a.commentCount ?? 0), 0);
  // 零值不写成 0——「0 阅读」看着像坏了，写成破折号读作「尚无」
  const fig = (n: number) => (n > 0 ? n.toLocaleString() : "—");
  const mmdd = (d?: string) => (d ?? "").slice(5).replace("-", ".");
  const newestAt = articles[0]?.publishedAt;
  const oldestAt = articles[articles.length - 1]?.publishedAt;
  const sealChar = [...tag.trim()][0] ?? "话";

  return (
    <div className="tag-page">
      <header className="tag-hero">
        <div className="tag-hero-main">
          <p className="tag-kicker">话题卷宗 · TOPIC FILE</p>
          <h1 className="tag-title">
            <span className="tag-hash" aria-hidden="true">
              #
            </span>
            <span className="tag-name">{tag}</span>
            <i className="tag-seal" aria-hidden="true">
              {sealChar}
            </i>
          </h1>
          <p className="tag-sub">
            墨栈上围绕「{tag}」的全部公开文章，按发布时间倒序登记；同一话题下的追问与续写都会留在这里。
          </p>
        </div>

        <aside className="tag-plate" aria-label={`话题「${tag}」卷宗统计`}>
          <span className="tp-label">卷宗登记</span>
          <span className="tp-total">
            <b>{articles.length}</b>
            <i>篇</i>
          </span>
          <span className="tp-rule" aria-hidden="true" />
          <div className="tp-figs">
            <span className={"tp-cell" + (totalRead > 0 ? " on" : "")}>
              <b>{fig(totalRead)}</b>
              <i>累计阅读</i>
            </span>
            <span className={"tp-cell" + (totalLike > 0 ? " on" : "")}>
              <b>{fig(totalLike)}</b>
              <i>累计获赞</i>
            </span>
            <span className={"tp-cell" + (totalComment > 0 ? " on" : "")}>
              <b>{fig(totalComment)}</b>
              <i>累计评论</i>
            </span>
          </div>
          {newestAt && oldestAt && (
            <>
              <span className="tp-rule" aria-hidden="true" />
              <span className="tp-range">
                区间 {mmdd(oldestAt)} <i>→</i> {mmdd(newestAt)}
              </span>
            </>
          )}
        </aside>

        {relatedTags.length > 0 && (
          <nav className="tag-spectrum" aria-label="邻近话题">
            <span className="ts-label">邻近话题</span>
            <div className="ts-chips">
              {relatedTags.map(([t, n]) => (
                <Link key={t} className="tag-chip" href={`/tag/${encodeURIComponent(t)}`}>
                  {t} <i>{n}</i>
                </Link>
              ))}
            </div>
          </nav>
        )}
      </header>

      {articles.length === 0 ? (
        <div className="tag-empty">
          <span className="te-seal" aria-hidden="true">
            空
          </span>
          <b>「{tag}」名下还没有公开文章</b>
          <p>
            这个卷宗还是空的——可能是话题刚起，也可能是同类文章挂了别的标签。
            先去热榜看看大家在写什么，或者直接开一篇，把它变成这个话题的第一条登记。
          </p>
          <div className="te-acts">
            <Link className="tag-cta" href="/hot?range=all">
              去热榜看看 →
            </Link>
            <Link className="tag-cta ghost" href="/studio">
              开一篇新文章 →
            </Link>
          </div>
        </div>
      ) : (
        <ol className="tag-cases">
          {articles.map((a, i) => {
            const sum = plainText(a.summary);
            return (
              <li className="tag-case" key={a.slug}>
                <div className="tc-axis" aria-hidden="true">
                  <span className={"tc-no" + (a.boostUntil ? " hot" : "")}>
                    {CN_NUM[i] ?? String(i + 1)}
                  </span>
                </div>
                <article className="tc-body">
                  <div className="tc-top">
                    <span className="tc-reg">
                      NO.{String(i + 1).padStart(2, "0")}
                      <i> / {String(articles.length).padStart(2, "0")}</i>
                    </span>
                    {a.boostUntil && <span className="tag-chip hot">加热中</span>}
                    {(a.tipTotal ?? 0) >= 50 && <span className="tag-chip tip">赏 {a.tipTotal ?? 0}</span>}
                  </div>
                  <h3 className="tc-title">
                    <Link href={`/article/${a.slug}`}>{a.title}</Link>
                  </h3>
                  {sum && <p className="tc-sum">{sum}</p>}
                  <div className="tc-meta">
                    {a.authorId ? (
                      <Link className="meta-author" href={`/author/${a.authorId}`}>
                        {a.author}
                      </Link>
                    ) : (
                      <span>{a.author}</span>
                    )}
                    <span>{a.publishedAt}</span>
                    <span className={a.readCount > 0 ? "on" : undefined}>
                      阅 <b>{a.readCount.toLocaleString()}</b>
                    </span>
                    <span className={(a.likeCount ?? 0) > 0 ? "on" : undefined}>
                      赞 <b>{a.likeCount ?? 0}</b>
                    </span>
                    <span className={(a.commentCount ?? 0) > 0 ? "on" : undefined}>
                      评 <b>{a.commentCount ?? 0}</b>
                    </span>
                    {a.tags
                      .filter((t) => t !== tag)
                      .slice(0, 3)
                      .map((t) => (
                        <Link key={t} className="tag-chip mini" href={`/tag/${encodeURIComponent(t)}`}>
                          # {t}
                        </Link>
                      ))}
                  </div>
                </article>
              </li>
            );
          })}
          <li className="tag-case-end">
            <span className="tce-line" aria-hidden="true" />
            <span className="tce-seal">卷末</span>
            <span className="tce-line" aria-hidden="true" />
          </li>
        </ol>
      )}

      <footer className="tag-foot">
        <div className="hf-note">
          <b>关于「话题卷宗」</b>
          <p>
            同一话题下的文章会一直留在这里，按发布倒序登记，不会因为热度变化被挤走。
            加热中的文章会被顶到热榜前排，但本页顺序始终是时间序——想横向比较不同话题谁更热，去热榜看实时重算的榜单。
          </p>
        </div>
        <div className="hf-acts">
          <Link className="hf-cta" href="/hot?range=all">
            <i aria-hidden="true">热</i>
            <span className="hf-body">
              <b>热度演武场</b>
              <small>看全站榜单与热度是怎么算出来的</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/search">
            <i aria-hidden="true">谱</i>
            <span className="hf-body">
              <b>墨谱检索台</b>
              <small>按话题分类翻，一次看全同类文章</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/archive">
            <i aria-hidden="true">档</i>
            <span className="hf-body">
              <b>全站归档</b>
              <small>按时间轴翻全部已发文章</small>
            </span>
          </Link>
        </div>
      </footer>
    </div>
  );
}
