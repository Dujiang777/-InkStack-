import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getAuthor, listAuthorArticles, followStats, isFollowing, listSeries, effectiveUnlockPrice } from "@/lib/data";
import { avatarClasses } from "@/lib/avatar";
import FollowButton from "@/components/FollowButton";
import { plainText } from "@/components/plain-text";

// 作者主页 /author/[id]「墨者册页」
// 版式：墨者题签（头像印 + 名号 + 墨绩签 / 数据签 + 关注）→
//       册页双栏（主栏：文章墨轴挂章；侧栏：专栏书脊）/ 卷末收口 / 脚注带
const CN_NUM = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];

export default async function AuthorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authorId = Number(id);
  const author = Number.isInteger(authorId) ? await getAuthor(authorId) : null;
  if (!author) notFound();

  const viewer = await getCurrentUser();
  const isSelf = viewer?.id === author.id;
  const [articles, stats, following, series] = await Promise.all([
    listAuthorArticles(author.id, 50),
    followStats(author.id),
    isSelf ? Promise.resolve(false) : isFollowing(viewer?.id ?? null, author.id),
    listSeries(6, author.id),
  ]);
  const totalRead = author.readTotal;
  // 零值写成破折号读作「尚无」，比「0」更像记录缺失而不是渲染坏了
  const fig = (n: number) => (n > 0 ? n.toLocaleString() : "—");
  // 墨路带：只用已加载的文章列表做时间轴聚合，不新增查询
  const mmdd = (d?: string) => (d ?? "").slice(5).replace("-", ".");
  const dates = articles.map((a) => a.publishedAt).filter(Boolean).sort();
  const firstAt = dates[0];
  const lastAt = dates[dates.length - 1];

  return (
    <div className="author-page">
      <header className="author-hero">
        <div className="author-hero-main">
          <span className={"avatar avatar-xl author-seal " + avatarClasses(author.avatarTone, author.avatarShape, author.id)} aria-hidden="true">
            {author.avatarText}
          </span>
          <div className="ah-text">
            <p className="tag-kicker">驻站作者 · CONTRIBUTOR</p>
            <h1 className="author-name">
              {author.nickname}
              {isSelf && <i className="author-self">这是我</i>}
            </h1>
            <p className="author-bio">{author.bio || "这位作者还没留下签名。"}</p>
            <p className="author-since">墨栈入驻 · {author.createdAt || "—"}</p>
          </div>
        </div>

        <aside className="tag-plate author-plate" aria-label={`${author.nickname} 的墨绩`}>
          <span className="tp-label">墨者档 · 撰稿</span>
          <span className="tp-total">
            <b>{author.articles.toLocaleString()}</b>
            <i>篇</i>
          </span>
          <span className="tp-rule" aria-hidden="true" />
          <div className="tp-figs author-figs">
            <span className={"tp-cell" + (totalRead > 0 ? " on" : "")}>
              <b>{fig(totalRead)}</b>
              <i>累计阅读</i>
            </span>
            <span className={"tp-cell" + (author.likes > 0 ? " on" : "")}>
              <b>{fig(author.likes)}</b>
              <i>累计获赞</i>
            </span>
            <span className={"tp-cell" + (stats.followers > 0 ? " on" : "")}>
              <b>{fig(stats.followers)}</b>
              <i>读者</i>
            </span>
          </div>
          <span className="tp-rule" aria-hidden="true" />
          <div className="author-acts">
            {isSelf ? (
              <Link className="hero-cta ghost author-cta" href="/study">
                管理我的书房 →
              </Link>
            ) : (
              <FollowButton
                authorId={author.id}
                initialFollowing={following}
                initialFollowers={stats.followers}
              />
            )}
          </div>
        </aside>

        <div className="author-ledger">
          <span className="al-label">墨路</span>
          <div className="al-cells">
            {firstAt ? (
              <>
                <span className="al-cell">
                  <b>{mmdd(firstAt)}</b>
                  <i>首次登记</i>
                </span>
                <span className="al-cell">
                  <b>{mmdd(lastAt)}</b>
                  <i>最近更新</i>
                </span>
              </>
            ) : (
              <span className="al-cell">
                <b>—</b>
                <i>尚无登记</i>
              </span>
            )}
            <span className={"al-cell" + (series.length > 0 ? " on" : "")}>
              <b>{series.length}</b>
              <i>本专栏</i>
            </span>
          </div>
        </div>
      </header>

      <div className="author-body">
        <section className="author-main" aria-label="作者文章">
          <div className="section-head author-main-head">
            <h2>TA 的文章</h2>
            <span className="more muted">共 {articles.length} 篇 · 按发布倒序</span>
          </div>

          {articles.length === 0 ? (
            <div className="tag-empty">
              <span className="te-seal" aria-hidden="true">
                空
              </span>
              <b>{author.nickname} 名下还没有公开文章</b>
              <p>
                好墨正在研磨中——被隐藏或退回的文章不会出现在这一册里。
                先关注 TA 不错过新作，或者去热榜看看此刻大家在写什么。
              </p>
              <div className="te-acts">
                <Link className="tag-cta" href="/hot?range=all">
                  去热榜看看 →
                </Link>
                <Link className="tag-cta ghost" href="/archive">
                  翻全站归档 →
                </Link>
              </div>
            </div>
          ) : (
            <ol className="tag-cases author-cases">
              {articles.map((a, i) => {
                const sum = plainText(a.summary);
                return (
                  <li className="tag-case" key={a.slug}>
                    <div className="tc-axis" aria-hidden="true">
                      <span className="tc-no">{CN_NUM[i] ?? String(i + 1)}</span>
                    </div>
                    <article className="tc-body">
                      <div className="tc-top">
                        <span className="tc-reg">
                          NO.{String(i + 1).padStart(2, "0")}
                          <i> / {String(articles.length).padStart(2, "0")}</i>
                        </span>
                        <span className="tag-chip">{a.tags[0] ?? a.coverLabel}</span>
                        {(a.unlockPrice ?? 0) > 0 && (
                          <span className="tag-chip paid">付费 {effectiveUnlockPrice(a)}墨</span>
                        )}
                        {(a.tipTotal ?? 0) >= 50 && (
                          <span className="tag-chip tip">赏 {a.tipTotal ?? 0}</span>
                        )}
                      </div>
                      <h3 className="tc-title">
                        <Link href={`/article/${a.slug}`}>{a.title}</Link>
                      </h3>
                      {sum && <p className="tc-sum">{sum}</p>}
                      <div className="tc-meta">
                        <span className={a.readCount > 0 ? "on" : undefined}>
                          阅 <b>{a.readCount.toLocaleString()}</b>
                        </span>
                        <span className={(a.likeCount ?? 0) > 0 ? "on" : undefined}>
                          赞 <b>{a.likeCount ?? 0}</b>
                        </span>
                        <span className={(a.commentCount ?? 0) > 0 ? "on" : undefined}>
                          评 <b>{a.commentCount ?? 0}</b>
                        </span>
                        <span>{a.publishedAt}</span>
                      </div>
                    </article>
                  </li>
                );
              })}
              <li className="tag-case-end">
                <span className="tce-line" aria-hidden="true" />
                <span className="tce-seal">这册到此</span>
                <span className="tce-line" aria-hidden="true" />
              </li>
            </ol>
          )}
        </section>

        <aside className="author-side" aria-label="作者专栏">
          <div className="as-head">
            <h2>TA 的专栏</h2>
            <span>{series.length} 本</span>
          </div>

          {series.length > 0 ? (
            <ol className="series-shelf author-shelf">
              {series.map((s, i) => (
                <li key={s.id} className="series-card author-spine">
                  <span className="asc-no" aria-hidden="true">
                    {CN_NUM[i] ?? String(i + 1)}
                  </span>
                  <div className="sc-main">
                    <Link href={`/series/${s.id}`} className="sc-title">
                      {s.title}
                      <i className="sc-count">{s.articleCount} 篇</i>
                    </Link>
                    {s.description && <p className="sc-desc">{s.description}</p>}
                    <p className="sc-meta">
                      <span>{s.totalReads.toLocaleString()} 阅</span>
                      {s.soldCount > 0 && (
                        <span className="sc-sold" title="打包解锁篇目人次">
                          ▲ 售出 {s.soldCount.toLocaleString()} 篇次
                        </span>
                      )}
                      <span>更新于 {s.updatedAt}</span>
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="author-noseries">
              <span className="ans-seal" aria-hidden="true">
                待
              </span>
              <b>还没有成册的专栏</b>
              <p>零散的文章还没被编进一条脉络。等攒够主题，这里就会多出一册可整卷解锁的专栏。</p>
              <Link className="tag-cta ghost" href={isSelf ? "/study" : "/series"}>
                {isSelf ? "去书房开专栏 →" : "看看全部专栏 →"}
              </Link>
            </div>
          )}
        </aside>
      </div>

      <footer className="author-foot">
        <div className="hf-note">
          <b>关于「墨者册页」</b>
          <p>
            这里只登记已过审并公开发布的文章，按发布时间倒序装订，不会因为热度变化被挤走；
            被隐藏或退回的篇目不在这一册里。侧栏的专栏是本页的装订线——同一脉络的多篇会被编到一处，
            整册解锁通常比逐篇便宜。
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
          <Link className="hf-cta" href="/archive">
            <i aria-hidden="true">档</i>
            <span className="hf-body">
              <b>全站归档</b>
              <small>按时间轴翻全部已发文章</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/search">
            <i aria-hidden="true">谱</i>
            <span className="hf-body">
              <b>墨谱检索台</b>
              <small>按话题分类翻，一次看全同类文章</small>
            </span>
          </Link>
        </div>
      </footer>
    </div>
  );
}
