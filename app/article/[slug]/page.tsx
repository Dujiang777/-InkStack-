import { notFound } from "next/navigation";
import Link from "next/link";
import { getArticle, listComments, listRelated, listArticleTips, isFollowing, isBookmarked, followStats, getArticleSeriesNav, listMySeries } from "@/lib/data";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { renderMarkdown, withHeadingIds } from "@/lib/render";
import AgentChat from "@/components/AgentChat";
import ReadingProgress from "@/components/ReadingProgress";
import ArticleEnhance from "@/components/ArticleEnhance";
import CommentsSection from "@/components/CommentsSection";
import ArticleActions from "@/components/ArticleActions";
import FollowButton from "@/components/FollowButton";
import TocNav from "@/components/TocNav";
import ReadTracker from "@/components/ReadTracker";
import PaywallCard from "@/components/PaywallCard";
import SeriesPicker from "@/components/SeriesPicker";
import { effectiveUnlockPrice } from "@/lib/data";
import { avatarClasses } from "@/lib/avatar";

/** 付费墙试读：锁定读者只拿到前 12 行，再收在段落边界（固定最多 6 行，杜绝短文泄漏） */
function teaserOf(md: string): string {
  const lines = md.split("\n");
  const cut = Math.min(6, lines.length);
  let teaser = lines.slice(0, cut).join("\n");
  const lastBlank = teaser.lastIndexOf("\n\n");
  if (lastBlank > 40) teaser = teaser.slice(0, lastBlank);
  return teaser;
}

// 文章页（双栏杂志版式）：
// 左栏 = 正文 + 底部动作条（点赞/加热/打赏——打赏留在文章下方）+ 评论区 + 相关阅读
// 右栏 = 分身对话卡（sticky，不再压在文章最下面）+ 本文目录
// 审核流：pending/rejected 文章仅作者与管理员可见，页顶展示状态横幅
export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getCurrentUser();
  const privileged = isStaff(viewer?.role);
  const article = await getArticle(slug, { id: viewer?.id ?? null, privileged }, { includeMd: false });
  if (!article) notFound();

  // 付费墙：定价 > 0 且浏览者无权阅读（非作者/管理员/已购）时只出试读；有权读才取全文
  const unlockPrice = article.unlockPrice ?? 0;
  const payPrice = effectiveUnlockPrice(article); // 早鸟价生效时为折后价
  const hasDiscount = payPrice < unlockPrice;
  const locked = unlockPrice > 0 && !article.viewerUnlocked;
  let bodyMd = article.md;
  if (!locked) {
    const full = await getArticle(slug, { id: viewer?.id ?? null, privileged });
    if (full) bodyMd = full.md;
  }
  const html0 = await renderMarkdown(locked ? teaserOf(bodyMd) : bodyMd);
  const charCount = (bodyMd.match(/[^\s]/g) ?? []).length;
  const { html, toc } = withHeadingIds(html0);
  const comments = await listComments(slug, viewer?.id ?? null);
  const related = await listRelated(slug, article.authorId, article.tags);
  const readMinutes = Math.max(1, Math.round(charCount / 450));
  const isOwner = viewer?.id != null && viewer.id === article.authorId;
  // 关注态（作者本人不显示按钮）
  const showFollow = Boolean(article.authorId) && viewer?.id !== article.authorId;
  const [viewerFollows, followInfo, tips, saved, seriesNav] = await Promise.all([
    showFollow ? isFollowing(viewer?.id ?? null, article.authorId ?? 0) : Promise.resolve(false),
    showFollow && article.authorId ? followStats(article.authorId) : Promise.resolve({ followers: 0, following: 0 }),
    listArticleTips(slug),
    isBookmarked(viewer?.id ?? null, slug),
    getArticleSeriesNav(slug),
  ]);
  // 作者快捷入柜：仅本人的非待审/非驳回文章显示「收进专栏」面板
  // （reviewStatus 仅在 pending/rejected 时有值，approved 时为 undefined，故不能用 === "approved" 判断）
  const pickable = isOwner && article.reviewStatus !== "pending" && article.reviewStatus !== "rejected";
  const mySeriesForPick = pickable && viewer ? await listMySeries(viewer.id) : [];

  return (
    <div className="article-page">
      <ReadingProgress />
      {viewer && article.reviewStatus !== "approved" && (
        <div className={`review-banner rb-${article.reviewStatus}`}>
          {article.reviewStatus === "pending" ? (
            <>
              <b>审核中</b> 这篇文章通过审核后对所有读者可见，当前仅你与运营可见。
            </>
          ) : (
            <>
              <b>未通过审核</b> 原因：{article.reviewNote ?? "不符合社区规范"}。
            </>
          )}
          {isOwner && (
            <a className="rb-edit" href={`/studio?edit=${encodeURIComponent(slug)}`}>
              去编辑重新提交 →
            </a>
          )}
        </div>
      )}

      <div className="article-layout">
        {/* ---------- 左栏：正文 + 动作条 ---------- */}
        <article className="article-main">
          <p className="crumbs">
            技术 ·{" "}
            {article.tags.length > 0
              ? article.tags.map((t, i) => (
                  <span key={t}>
                    {i > 0 && " / "}
                    <Link className="crumb-tag" href={`/tag/${encodeURIComponent(t)}`}>
                      #{t}
                    </Link>
                  </span>
                ))
              : "专栏"}{" "}
            / {article.coverLabel}
          </p>
          <h1 className="article-title">{article.title}</h1>
          <div className="article-meta">
            <span className={"avatar " + avatarClasses(article.authorTone, article.authorShape, article.authorId)} aria-hidden="true">{article.authorAvatar}</span>
            <b>
              {article.authorId ? (
                <Link className="meta-author" href={`/author/${article.authorId}`}>
                  {article.author}
                </Link>
              ) : (
                article.author
              )}
            </b>
            <span>
              {/* v17.1：published_at 为空的历史文章不再渲染出 "null / · 约…" 的悬挂分隔符 */}
              {article.publishedAt ? `${article.publishedAt} · ` : ""}约 {readMinutes} 分钟读完 · {charCount.toLocaleString()} 字 · 阅读{" "}
              {article.readCount.toLocaleString()}
            </span>
            <span className="tag-chip accent">分身已回答 {article.agentQaCount.toLocaleString()} 次</span>
            {article.boostUntil && <span className="tag-chip hot">热</span>}
            {unlockPrice > 0 && (
              <span className={"tag-chip" + (locked ? " lock" : "")}>
                {locked ? `付费 ${payPrice} 点墨${hasDiscount ? "（早鸟）" : ""}` : "付费已解锁"}
              </span>
            )}
            {article.authorId && viewer?.id !== article.authorId && (
              <FollowButton
                authorId={article.authorId}
                initialFollowing={viewerFollows}
                initialFollowers={followInfo.followers}
              />
            )}
            {article.authorId && viewer?.id === article.authorId && (
              <span className="tag-chip">这是你的文章</span>
            )}
          </div>
          {seriesNav && (
            <div className="series-box">
              <p className="sb-kicker">
                专栏 · 第 {seriesNav.position} 篇 / 共 {seriesNav.total} 篇
              </p>
              <Link className="sb-title" href={`/series/${seriesNav.id}`}>
                《{seriesNav.title}》
              </Link>
              <div className="sb-nav">
                {seriesNav.prev ? (
                  <Link className="sb-link" href={`/article/${seriesNav.prev.slug}`} title={seriesNav.prev.title}>
                    ← 上一篇
                  </Link>
                ) : (
                  <span className="sb-none">已是第一篇</span>
                )}
                {seriesNav.next ? (
                  <Link className="sb-link next" href={`/article/${seriesNav.next.slug}`} title={seriesNav.next.title}>
                    下一篇 →
                  </Link>
                ) : (
                  <span className="sb-none">已是最新一篇</span>
                )}
              </div>
            </div>
          )}
          <div className="article-body" dangerouslySetInnerHTML={{ __html: html }} />
          {locked && (
            <PaywallCard
              slug={slug}
              price={payPrice}
              originalPrice={hasDiscount ? unlockPrice : undefined}
              discountUntil={article.discountUntil}
              unlockCount={article.unlockCount ?? 0}
              charCount={charCount}
              qaCount={article.agentQaCount ?? 0}
              loggedIn={Boolean(viewer)}
              balance={viewer?.points ?? null}
            />
          )}

          {pickable && (
            <SeriesPicker
              slug={slug}
              series={mySeriesForPick.map((s) => ({ id: s.id, title: s.title, items: s.items.map((x) => x.slug) }))}
            />
          )}
          <ArticleActions
            slug={slug}
            authorId={article.authorId ?? 0}
            viewerId={viewer?.id ?? null}
            boostUntil={article.boostUntil ?? null}
            tipTotal={article.tipTotal ?? 0}
            likeCount={article.likeCount ?? 0}
            liked={Boolean(article.viewerLiked)}
            bookmarked={saved}
          />
          <ReadTracker slug={slug} />
        </article>

        {/* ---------- 右栏：分身 + 目录（sticky） ---------- */}
        <aside className="article-side">
          <div className="article-side-inner">
            <AgentChat author={article.author} agentQaCount={article.agentQaCount} />
            <TocNav items={toc} />
            {tips.length > 0 && (
              <section className="tips-feed-card" aria-label="最新墨水">
                <b className="tf-head">
                  最新墨水
                  <span className="tf-total">{(article.tipTotal ?? 0).toLocaleString()} 滴</span>
                </b>
                <ul>
                  {tips.map((t, i) => (
                    <li key={i}>
                      <span className="avatar tf-ava" aria-hidden="true">
                        {t.fromAvatar}
                      </span>
                      <span className="tf-name">{t.fromName}</span>
                      <span className="tf-amt">+{t.amount} 滴</span>
                      <span className="tf-time">{t.createdAt}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </aside>

        {/* ---------- 评论区 + 相关阅读（左栏下方，始终垫底） ---------- */}
        <div className="article-comments">
          <CommentsSection slug={slug} initial={comments} />
          {related.length > 0 && (
            <section className="related-card" aria-label="相关阅读">
              <b className="related-head">继续读 · 相关文章</b>
              <ul>
                {related.map((r) => (
                  <li key={r.slug}>
                    <a href={`/article/${r.slug}`}>
                      <span className="rt">{r.title}</span>
                      <span className="rm">
                        {r.author} · {r.readCount.toLocaleString()} 阅 · {r.likeCount ?? 0} 赞
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <ArticleEnhance />
    </div>
  );
}
