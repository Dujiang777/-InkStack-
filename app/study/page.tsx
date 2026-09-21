import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { listMyArticles, authorArticleStats, listMySeries, listMyUnlockIncome, listMyFunnel, suggestSeriesTitles } from "@/lib/data";
import StudyClient from "@/components/StudyClient";
import SeriesManager from "@/components/SeriesManager";

// 我的书房：个人主页 + 文章管理（草稿/待审/驳回/已发布），驳回可改后重新提交 + 专栏合集管理
export default async function StudyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { rows, stats } = await listMyArticles(user.id);
  const workStats = await authorArticleStats(user.id);
  const maxRead = Math.max(1, ...workStats.map((w) => w.readCount));
  const [mySeries, publishedArticles, unlockIncome, funnel, suggestions] = await Promise.all([
    listMySeries(user.id),
    Promise.resolve(
      rows
        .filter((a) => a.status === "published" && a.reviewStatus === "approved")
        .map((a) => ({ slug: a.slug, title: a.title }))
    ),
    listMyUnlockIncome(user.id),
    listMyFunnel(user.id),
    suggestSeriesTitles(user.id),
  ]);

  return (
    <div className="study-page">
      <div className="section-head">
        <h2>我的书房</h2>
        <span className="admin-flag">
          {user.nickname} · 墨仓 {user.points.toLocaleString()} 点
        </span>
      </div>

      <div className="study-stats">
        <div className="stat">
          <span className="stat-no">{stats.published}</span>
          <span className="stat-label">公开文章</span>
        </div>
        <div className="stat">
          <span className="stat-no">{stats.totalReads.toLocaleString()}</span>
          <span className="stat-label">累计阅读</span>
        </div>
        <div className="stat">
          <span className="stat-no">{stats.totalLikes.toLocaleString()}</span>
          <span className="stat-label">收获点赞</span>
        </div>
        <div className="stat">
          <span className="stat-no">{stats.totalQa.toLocaleString()}</span>
          <span className="stat-label">分身问答</span>
        </div>
        <div className="stat">
          <span className="stat-no">{stats.tipIncome.toLocaleString()}</span>
          <span className="stat-label">打赏收入（滴）</span>
        </div>
        <div className="stat stat-unlock">
          <span className="stat-no">{unlockIncome.total.toLocaleString()}</span>
          <span className="stat-label">解锁收入（滴）</span>
        </div>
        <div className="stat stat-draft">
          <span className="stat-no">{stats.drafts}</span>
          <span className="stat-label">草稿待耕</span>
        </div>
      </div>

      {/* ---------- 作品数据明细（每篇条形） ---------- */}
      <section className="work-stats">
        <div className="section-head">
          <h3>作品数据 · 按阅读量排</h3>
          <span className="admin-flag">阅读 / 点赞 / 评论 / 打赏</span>
        </div>
        {workStats.length === 0 ? (
          <p className="ws-empty">还没有作品数据。去发布台耕第一篇吧。</p>
        ) : (
          <ul className="ws-list">
            {workStats.map((w) => (
              <li key={w.slug} className="ws-row">
                <div className="ws-line">
                  <Link href={`/article/${w.slug}`} className="ws-title">
                    {w.title}
                    {w.status === "draft" && <i className="ws-badge">草稿</i>}
                    {w.status === "review" && <i className="ws-badge warn">待审</i>}
                    {w.status === "rejected" && <i className="ws-badge err">驳回</i>}
                    {w.boostUntil && <i className="ws-badge hot">加热中</i>}
                  </Link>
                  <span className="ws-meta">
                    {w.readCount.toLocaleString()} 读 · {w.likeCount} 赞 · {w.commentCount} 评 · {w.tipTotal} 滴赏
                  </span>
                </div>
                <span className="ws-track">
                  <span className="ws-bar" style={{ width: `${Math.max(2, Math.round((w.readCount / maxRead) * 100))}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- 付费转化漏斗 ---------- */}
      {funnel.length > 0 && (
        <section className="funnel-board">
          <div className="section-head">
            <h3>付费转化漏斗</h3>
            <span className="admin-flag">阅读 → 付费墙 → 解锁</span>
          </div>
          <div className="fn-totals">
            {(() => {
              const v = funnel.reduce((s, f) => s + f.views, 0);
              const p = funnel.reduce((s, f) => s + f.paywallViews, 0);
              const u = funnel.reduce((s, f) => s + f.unlocks, 0);
              const rev = funnel.reduce((s, f) => s + f.revenue, 0);
              return (
                <>
                  <span className="fn-total"><b>{v.toLocaleString()}</b>阅读</span>
                  <i className="fn-arrow" aria-hidden="true">→</i>
                  <span className="fn-total"><b>{p.toLocaleString()}</b>到墙<small>{v > 0 ? ` ${Math.round((p / v) * 100)}%` : ""}</small></span>
                  <i className="fn-arrow" aria-hidden="true">→</i>
                  <span className="fn-total"><b>{u.toLocaleString()}</b>解锁<small>{p > 0 ? ` ${Math.round((u / p) * 100)}%` : ""}</small></span>
                  <span className="fn-rev">到手 <b>{rev.toLocaleString()}</b> 滴</span>
                </>
              );
            })()}
          </div>
          <ul className="fn-list">
            {funnel.map((f) => {
              const wallRate = f.views > 0 ? Math.round((f.paywallViews / f.views) * 100) : 0;
              const buyRate = f.paywallViews > 0 ? Math.round((f.unlocks / f.paywallViews) * 100) : 0;
              return (
                <li key={f.slug} className="fn-row">
                  <Link href={`/article/${f.slug}`} className="fn-title">{f.title}</Link>
                  <span className="fn-steps" aria-label={`阅读 ${f.views}，到墙 ${f.paywallViews}（${wallRate}%），解锁 ${f.unlocks}（${buyRate}%）`}>
                    <span className="fn-step"><i style={{ width: "100%" }} /><b>读 {f.views.toLocaleString()}</b></span>
                    <span className="fn-step"><i style={{ width: `${Math.max(3, Math.min(100, wallRate))}%` }} /><b>墙 {f.paywallViews.toLocaleString()} · {wallRate}%</b></span>
                    <span className="fn-step gold"><i style={{ width: `${Math.max(3, Math.min(100, buyRate))}%` }} /><b>解锁 {f.unlocks} · {buyRate}%</b></span>
                  </span>
                  <span className="fn-earn">到手 <b>{f.revenue.toLocaleString()}</b> 滴</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ---------- 付费解锁收入明细 ---------- */}
      {unlockIncome.sales > 0 && (
        <section className="unlock-income">
          <div className="section-head">
            <h3>付费解锁 · 收入明细</h3>
            <span className="admin-flag">
              {unlockIncome.sales} 次解锁 · 到手 {unlockIncome.total.toLocaleString()} 滴（70% 分成）
            </span>
          </div>
          <ul className="ui-list">
            {unlockIncome.byArticle.map((u) => (
              <li key={u.slug} className="ui-row">
                <Link href={`/article/${u.slug}`} className="ui-title">
                  {u.title}
                </Link>
                <span className="ui-meta">
                  定价 {u.price} 滴 · {u.sales} 次解锁 · 到手 <b>{u.earned.toLocaleString()}</b> 滴
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <StudyClient rows={rows} />

      <SeriesManager initial={mySeries} myArticles={publishedArticles} suggestions={suggestions} />
    </div>
  );
}
