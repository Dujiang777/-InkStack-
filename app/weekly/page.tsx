import type { Metadata } from "next";
import Link from "next/link";
import { listWeekly } from "@/lib/data";

// 每周墨报：全站自动周报（近 7 天新刊/新读者/评论/打赏/新专栏 + 热度 TOP5 + 近 6 周发文走势）
export const dynamic = "force-dynamic";

const CN_NUM = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];

export const metadata: Metadata = {
  title: "每周墨报 · 墨栈",
  description: "墨栈全站周报：近 7 天新刊、热度演武、新架专栏、墨水流动一览。",
};

export default async function WeeklyPage() {
  const r = await listWeekly();
  const maxWeek = Math.max(1, ...r.weeks.map((w) => w.count));
  const stats: { no: string; label: string; value: string }[] = [
    { no: "壹", label: "本周新刊", value: String(r.newArticles) },
    { no: "贰", label: "新驻读者", value: String(r.newUsers) },
    { no: "叁", label: "新增评论", value: String(r.newComments) },
    { no: "肆", label: "打赏笔数", value: String(r.tipCount) },
    { no: "伍", label: "流动墨水", value: String(r.tipInk) },
    { no: "陆", label: "新架专栏", value: String(r.newSeries) },
  ];

  return (
    <div className="weekly-page">
      {/* ---------- 报头 ---------- */}
      <header className="wk-head">
        <p className="wk-kicker">INKSTACK WEEKLY · 自动编纂 · 每周一阅</p>
        <h1>
          每周墨报 <span className="wk-issue">第{CN_NUM[Math.min(r.issue, 10)] ?? r.issue}期</span>
        </h1>
        <p className="wk-range">
          {r.from} — {r.to} · 墨栈编辑部（机器自动编印）
        </p>
        <p className="wk-motto">墨水按周结算，文章按热封赏；本周事，本周毕。</p>
      </header>

      {/* ---------- 总览数字 ---------- */}
      <section className="wk-stats" aria-label="本周总览">
        {stats.map((s) => (
          <div className="wk-stat" key={s.no}>
            <i>{s.no}</i>
            <b>{s.value}</b>
            <span>{s.label}</span>
          </div>
        ))}
      </section>

      <div className="wk-cols">
        {/* ---------- 左：热度演武 + 新刊目录 ---------- */}
        <div className="wk-main">
          <section className="wk-box">
            <h2 className="wk-title">封赏演武 · 本周热度五强</h2>
            {r.top.length === 0 ? (
              <p className="wk-empty">本周尚无刊文，静候下期。</p>
            ) : (
              <ol className="wk-top">
                {r.top.map((a, i) => (
                  <li key={a.slug}>
                    <Link href={`/article/${a.slug}`} className="wk-top-row">
                      <b className={"wk-rank" + (i < 3 ? " m" + (i + 1) : "")}>{i + 1}</b>
                      <span className="wk-top-main">
                        <span className="wk-top-title">{a.title}</span>
                        <span className="wk-top-meta">
                          {a.author} · 阅读 {a.readCount} · 评论 {a.commentCount}
                          {a.tipTotal ? ` · 打赏 ${a.tipTotal}` : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
            <Link className="wk-more" href="/hot">看完整热榜 →</Link>
          </section>

          <section className="wk-box">
            <h2 className="wk-title">本周新刊目录</h2>
            {r.latest.length === 0 ? (
              <p className="wk-empty">近 7 天暂无新刊。</p>
            ) : (
              <ul className="wk-list">
                {r.latest.map((a) => (
                  <li key={a.slug}>
                    <Link href={`/article/${a.slug}`}>
                      {a.coverLabel && <i className="wk-label">{a.coverLabel}</i>}
                      <b>{a.title}</b>
                      <span>{a.author} · {a.publishedAt}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link className="wk-more" href="/archive">翻全年归档 →</Link>
          </section>
        </div>

        {/* ---------- 右：走势 + 新架专栏 ---------- */}
        <aside className="wk-side">
          <section className="wk-box">
            <h2 className="wk-title">近六周发文走势</h2>
            <div className="wk-bars" role="img" aria-label="近六周每周发文量柱状图">
              {r.weeks.map((w) => (
                <div className="wk-bar-col" key={w.label}>
                  <b className="wk-bar" style={{ height: `${Math.max(6, (w.count / maxWeek) * 100)}%` }}>
                    {w.count > 0 && <i>{w.count}</i>}
                  </b>
                  <span>{w.label}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="wk-box">
            <h2 className="wk-title">新架专栏</h2>
            {r.series.length === 0 ? (
              <p className="wk-empty">暂无专栏上架。</p>
            ) : (
              <ul className="wk-series">
                {r.series.map((s) => (
                  <li key={s.id}>
                    <Link href={`/series/${s.id}`}>
                      <b>{s.title}</b>
                      <span>{s.author} · {s.articleCount} 篇 · 阅读 {s.totalReads}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link className="wk-more" href="/series">逛合集架 →</Link>
          </section>
        </aside>
      </div>

      <footer className="wk-foot">
        <span>—— 墨报完 ——</span>
        <p>本报告由墨栈编辑部（机器）于每周自动编印，数据截至发稿时刻。</p>
      </footer>
    </div>
  );
}
