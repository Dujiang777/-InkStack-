import Link from "next/link";
import { listArticles, platformStats, topAuthors, listMyFollowing, listFollowingFeed, listMyHistory, todayInkQuote, effectiveUnlockPrice } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import Reveal from "@/components/Reveal";
import InkQuote from "@/components/InkQuote";
import { plainText } from "@/components/plain-text";
import { avatarClasses } from "@/lib/avatar";

// 首页 v3：数据横幅 → 头条 → 热榜+作者榜侧栏 → 关注动态流（登录且有关注时）→ 编号卡片流
export default async function HomePage() {
  const user = await getCurrentUser();
  const [articles, stats, authors, feed, myFollowing, resume] = await Promise.all([
    listArticles(),
    platformStats(),
    topAuthors(5),
    user ? listFollowingFeed(user.id, 6) : Promise.resolve([]),
    user ? listMyFollowing(user.id, 3) : Promise.resolve([]),
    user ? listMyHistory(user.id, 4) : Promise.resolve([]),
  ]);
  const hot = articles.slice(0, 5);
  const quote = todayInkQuote();
  // 头条优选：近期文章里优先挑「有摘要且有阅读量」的，避免头条开天窗
  const heroPick =
    articles.slice(0, 6).find((a) => (a.summary ?? "").trim().length > 0 && a.readCount > 0) ??
    articles.slice(0, 6).find((a) => (a.summary ?? "").trim().length > 0) ??
    articles[0];
  const rest = articles.filter((a) => a.slug !== heroPick.slug);
  const duo = rest.slice(0, 2); // 头条下方第二行的两张卡，用于填满侧栏高度
  const gridCards = rest.slice(2);

  return (
    <div className="home">
      <Reveal />

      {/* ---------- 平台数据横幅：平台自己会运营的自证 ---------- */}
      <section className="home-strip" aria-label="平台数据">
        <div className="strip-item">
          <b>{stats.articles.toLocaleString()}</b>
          <span>在版文章</span>
        </div>
        <div className="strip-item">
          <b>{stats.authors.toLocaleString()}</b>
          <span>驻站作者</span>
        </div>
        <div className="strip-item">
          <b>{stats.qaTotal.toLocaleString()}</b>
          <span>分身问答</span>
        </div>
        <div className="strip-item">
          <b>{stats.tipsTotal.toLocaleString()}</b>
          <span>墨水打赏总量</span>
        </div>
      </section>

      {heroPick ? (
        <div className="home-top">
          <article className="hero-main">
            <i className="hero-seal" aria-hidden="true">
              墨
            </i>
            <span className="kicker">今日头条 · AI 编辑部推荐</span>
            <h1 className="hero-title">
              <Link href={`/article/${heroPick.slug}`}>{heroPick.title}</Link>
            </h1>
            <p className="hero-excerpt">{plainText(heroPick.summary)}</p>
            <div className="byline">
              <span className="avatar" aria-hidden="true">{heroPick.authorAvatar}</span>
              <span className="byline-text">
                <b>
                  {heroPick.authorId ? (
                    <Link className="meta-author" href={`/author/${heroPick.authorId}`}>
                      {heroPick.author}
                    </Link>
                  ) : (
                    heroPick.author
                  )}
                </b>
                <span>{heroPick.publishedAt}</span>
              </span>
              {heroPick.boostUntil && <span className="tag-chip hot">加热中</span>}
              {(heroPick.unlockPrice ?? 0) > 0 && <span className="tag-chip paid">付费 {effectiveUnlockPrice(heroPick)}墨</span>}
              {effectiveUnlockPrice(heroPick) < (heroPick.unlockPrice ?? 0) && <span className="tag-chip earlybird">早鸟</span>}
              <span className="tag-chip accent">分身在线</span>
            </div>
            <div className="hero-stats">
              <span>
                <b>{heroPick.readCount.toLocaleString()}</b>阅读
              </span>
              <span>
                <b>{(heroPick.likeCount ?? 0).toLocaleString()}</b>点赞
              </span>
              <span>
                <b>{heroPick.commentCount.toLocaleString()}</b>评论
              </span>
              <span>
                <b>{heroPick.agentQaCount.toLocaleString()}</b>问答
              </span>
              {(heroPick.tipTotal ?? 0) > 0 && (
                <span>
                  <b>{(heroPick.tipTotal ?? 0).toLocaleString()}</b>打赏
                </span>
              )}
            </div>
            <div className="hero-acts">
              <Link className="hero-cta" href={`/article/${heroPick.slug}`}>
                阅读全文
              </Link>
              <Link className="hero-cta ghost" href={`/article/${heroPick.slug}#agent-panel`}>
                问问 TA 的分身 →
              </Link>
            </div>
          </article>

          {/* 头条下方第二行：两张文章卡，填满侧栏高度、消灭空白 */}
          <div className="duo-cards">
            {duo.map((a, i) => (
              <article className="card card-ink" key={a.slug}>
                <span className="idx" aria-hidden="true">
                  {String(i + 4).padStart(2, "0")}
                </span>
                <Link className="tag-chip" href={`/tag/${encodeURIComponent(a.tags[0] ?? "专栏")}`}>
                  {a.tags[0] ?? a.coverLabel}
                </Link>
                {a.boostUntil && <span className="tag-chip hot">加热中</span>}
                {(a.unlockPrice ?? 0) > 0 && <span className="tag-chip paid">付费 {effectiveUnlockPrice(a)}墨</span>}
            {effectiveUnlockPrice(a) < (a.unlockPrice ?? 0) && <span className="tag-chip earlybird">早鸟</span>}
            {(a.tipTotal ?? 0) >= 50 && <span className="tag-chip tip">赏 {(a.tipTotal ?? 0)}</span>}
                <h3>
                  <Link href={`/article/${a.slug}`}>{a.title}</Link>
                </h3>
                <p>{plainText(a.summary)}</p>
                <div className="meta">
                  {a.authorId ? (
                    <Link className="meta-author" href={`/author/${a.authorId}`}>
                      {a.author}
                    </Link>
                  ) : (
                    <span>{a.author}</span>
                  )}
                  <span>
                    阅读 <b>{(a.readCount / 1000).toFixed(1)}k</b>
                  </span>
                  <span>
                    赞 <b>{a.likeCount}</b>
                  </span>
                  <span>
                    评 <b>{a.commentCount}</b>
                  </span>
                </div>
              </article>
            ))}
          </div>

          <aside className="hero-side">
            <InkQuote text={quote.text} from={quote.from} />

            {/* 漫游记大入口：不想挑？让墨水替你决定 */}
            <Link className="wander-card" href="/random" aria-label="漫游记：随机读一篇文章">
              <span className="wc-dice" aria-hidden="true">
                ⚄
              </span>
              <span className="wc-main">
                <b>漫游记</b>
                <small>不想挑？让墨水替你决定——随机掉进一篇文章</small>
              </span>
              <span className="wc-go" aria-hidden="true">
                →
              </span>
            </Link>

            {resume.length > 0 && (
              <>
                <h2 className="side-title">
                  继续读<span>RESUME</span>
                </h2>
                <ul className="resumelist">
                  {resume.slice(0, 3).map((h) => (
                    <li key={h.slug}>
                      <Link href={`/article/${h.slug}`}>
                        <span className="t">
                          {h.title}
                          <small className="m">
                            上次读到 {h.readAt.slice(5, 10)}
                            {h.times > 1 ? ` · 已读 ${h.times} 遍` : ""}
                          </small>
                        </span>
                        <span className="go" aria-hidden="true">
                          ↻
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h2 className="side-title">
              AI 编辑部 · 热榜<span>DAILY 5</span>
            </h2>
            <ol className="hotlist">
              {hot.map((a, i) => (
                <li key={a.slug}>
                  <Link href={`/article/${a.slug}`}>
                    <span className={"rank r" + (i + 1)}>{i + 1}</span>
                    <span className="t">
                      {a.title}
                      <small className="m">
                        {a.author} · {a.readCount.toLocaleString()} 阅
                        {a.boostUntil ? " · 加热中" : ""}
                      </small>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
            <Link className="side-more" href="/search">
              全站搜索 →
            </Link>
          </aside>
        </div>
      ) : (
        <section className="hero hero-empty">
          <span className="kicker">墨栈 INKSTACK</span>
          <h1 className="hero-title">还没有文章上线，头版虚位以待</h1>
          <p className="hero-excerpt">
            到 <Link href="/studio">AI 创作台</Link> 写下第一篇，或用迁移工坊把旧博客整体搬进来——发布即有分身陪读。
          </p>
          <div className="hero-acts">
            <Link className="hero-cta" href="/studio">
              去创作台 →
            </Link>
          </div>
        </section>
      )}

      {/* ---------- 驻站作者横带：通栏展示，平衡侧栏高度 ---------- */}
      {authors.length > 0 && (
        <section className="authors-band" aria-label="驻站作者">
          <div className="section-head">
            <h2>驻站作者</h2>
            <Link className="more" href="/search">
              发现更多作者 →
            </Link>
          </div>
          <div className="ab-grid">
            {authors.map((au, i) => (
              <Link key={au.id} href={`/author/${au.id}`} className="ab-card">
                <span className={"rank r" + (i + 1)}>{i + 1}</span>
                <span className={"avatar " + avatarClasses(au.avatarTone, au.avatarShape, au.id)} aria-hidden="true">
                  {au.avatarText}
                </span>
                <b className="ab-name">{au.nickname}</b>
                <small className="ab-stats">
                  {au.articles} 篇 · {au.likes.toLocaleString()} 赞 · {au.readTotal.toLocaleString()} 阅
                </small>
                <span className="ab-go" aria-hidden="true">
                  进主页 →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ---------- 关注动态流：登录且有关注作者时置顶展示，形成回访理由 ---------- */}
      {user && (
        <section className="feed-block" aria-label="关注动态">
          <div className="section-head">
            <h2>关注动态</h2>
            {myFollowing.length > 0 && (
              <span className="more muted">
                你正在追 {myFollowing.map((f) => f.nickname).join("、")} 的更新
              </span>
            )}
          </div>
          {feed.length > 0 ? (
            <ul className="feed-list">
              {feed.map((f) => (
                <li key={f.slug}>
                  <span className="avatar" aria-hidden="true">
                    {f.authorAvatar}
                  </span>
                  <div className="feed-main">
                    <b>
                      <Link href={`/author/${f.authorId}`}>{f.author}</Link>
                    </b>
                    <span className="feed-sep">刚发布了</span>
                    <Link className="feed-title" href={`/article/${f.slug}`}>
                      {f.title}
                    </Link>
                    <p>{plainText(f.summary)}</p>
                  </div>
                  <div className="feed-meta">
                    <span>{f.publishedAt}</span>
                    <span>
                      阅 <b>{f.readCount.toLocaleString()}</b>
                    </span>
                    <span>
                      赞 <b>{f.likeCount}</b>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="feed-empty">
              <p>
                {myFollowing.length === 0
                  ? "还没有关注的作者。去作者榜看看，点「+ 关注」，新文章第一时间出现在这里。"
                  : "你关注的作者最近还没有新文章，先逛逛最新文章吧。"}
              </p>
              <Link className="hero-cta ghost" href="/search">
                逛逛作者榜 →
              </Link>
            </div>
          )}
        </section>
      )}

      <div className="section-head">
        <h2>最新文章</h2>
        <Link className="more" href="/studio">
          去创作台写作 →
        </Link>
      </div>
      <div className="grid">
        {gridCards.map((a, i) => (
          <article className="card card-ink" key={a.slug}>
            <span className="idx" aria-hidden="true">
              {String(i + 4).padStart(2, "0")}
            </span>
            <Link className="tag-chip" href={`/tag/${encodeURIComponent(a.tags[0] ?? "专栏")}`}>
              {a.tags[0] ?? a.coverLabel}
            </Link>
            {a.boostUntil && <span className="tag-chip hot">加热中</span>}
            {(a.unlockPrice ?? 0) > 0 && <span className="tag-chip paid">付费 {effectiveUnlockPrice(a)}墨</span>}
            {effectiveUnlockPrice(a) < (a.unlockPrice ?? 0) && <span className="tag-chip earlybird">早鸟</span>}
            {(a.tipTotal ?? 0) >= 50 && <span className="tag-chip tip">赏 {(a.tipTotal ?? 0)}</span>}
            <h3>
              <Link href={`/article/${a.slug}`}>{a.title}</Link>
            </h3>
            <p>{plainText(a.summary)}</p>
            <div className="meta">
              {a.authorId ? (
                <Link className="meta-author" href={`/author/${a.authorId}`}>
                  {a.author}
                </Link>
              ) : (
                <span>{a.author}</span>
              )}
              <span>
                阅读 <b>{(a.readCount / 1000).toFixed(1)}k</b>
              </span>
              <span>
                赞 <b>{a.likeCount}</b>
              </span>
              <span>
                评 <b>{a.commentCount}</b>
              </span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
