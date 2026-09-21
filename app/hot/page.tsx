import Link from "next/link";
import type { Metadata } from "next";
import { listHot, type HotRange } from "@/lib/data";

export const metadata: Metadata = {
  title: "热榜 · 墨栈 InkStack",
  description: "墨栈全站热文榜：今日 / 本周 / 总榜三档热度排行。",
};

export const dynamic = "force-dynamic";

// 热榜页：三档时间窗的排名榜，前三甲印章名次，热度用墨迹计呈现
const RANGES: { key: HotRange; label: string; no: string; note: string }[] = [
  { key: "day", label: "今日热榜", no: "壹", note: "近 24 小时刊出的文章" },
  { key: "week", label: "本周热榜", no: "贰", note: "近 7 天刊出的文章" },
  { key: "all", label: "总榜", no: "叁", note: "开站以来全部文章" },
];

// 热度构成：拆成可扫读的因子，避免一整句公式糊在正文里
const FACTORS: { label: string; weight: string }[] = [
  { label: "阅读", weight: "×1" },
  { label: "点赞", weight: "×5" },
  { label: "评论", weight: "×5" },
  { label: "分身问答", weight: "×10" },
  { label: "打赏", weight: "×3" },
];

function heatOf(a: { readCount: number; commentCount: number; agentQaCount: number; likeCount?: number; tipTotal?: number }): number {
  return a.readCount + (a.likeCount ?? 0) * 5 + a.commentCount * 5 + a.agentQaCount * 10 + (a.tipTotal ?? 0) * 3;
}

export default async function HotPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { range: raw } = await searchParams;
  const explicit = raw === "week" || raw === "all" || raw === "day";
  let range: HotRange = explicit ? (raw as HotRange) : "day";
  let rows = await listHot(range);
  // 未显式选窗且当日无刊 → 自动落到有数据的时间窗（本周 → 总榜），空态只留给主动选择
  if (!explicit && rows.length === 0) {
    const weekRows = await listHot("week");
    if (weekRows.length > 0) {
      range = "week";
      rows = weekRows;
    } else {
      range = "all";
      rows = await listHot("all");
    }
  }
  const conf = RANGES.find((r) => r.key === range) ?? RANGES[0];
  const maxHeat = Math.max(1, ...rows.map(heatOf));
  const topHeat = rows.length > 0 ? heatOf(rows[0]) : 0;

  return (
    <div className="hot-page">
      <header className="hot-hero">
        <div className="hot-hero-main">
          <p className="hot-kicker">INKSTACK · TRENDING</p>
          <h1 className="hot-title">热度演武场</h1>
          <p className="hot-sub">
            只统计{conf.note}。热度按下列权重合成，榜单每次访问实时重算。
          </p>
        </div>

        {/* 榜单题签：一眼看清「此刻看的是哪一档、多少篇入榜、榜首多热」 */}
        <aside className="hot-plate" aria-label="当前榜单概览">
          <span className="hp-label">此刻在看</span>
          <b className="hp-range">{conf.label}</b>
          <span className="hp-rule" aria-hidden="true" />
          <span className="hp-figures">
            <span className="hp-cell">
              <b>{rows.length}</b>
              <i>篇入榜</i>
            </span>
            <span className="hp-cell">
              <b>{topHeat.toLocaleString()}</b>
              <i>榜首热度</i>
            </span>
          </span>
        </aside>
      </header>

      <ul className="hot-legend" aria-label="热度构成权重">
        {FACTORS.map((f) => (
          <li key={f.label}>
            <span>{f.label}</span>
            <b>{f.weight}</b>
          </li>
        ))}
      </ul>

      <nav className="hot-tabs" aria-label="榜单切换">
        {RANGES.map((r) => (
          <Link
            key={r.key}
            href={`/hot?range=${r.key}`}
            className={"hot-tab" + (r.key === range ? " on" : "")}
            aria-current={r.key === range ? "page" : undefined}
          >
            <i className="ht-no" aria-hidden="true">
              {r.no}
            </i>
            {r.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="hot-empty">
          <b>这个时间窗里还没有文章</b>
          <p>{range === "day" ? "今日尚无新刊，看看总榜的热度常青树吧。" : "稍后再来看看。"}</p>
          <div className="hot-empty-acts">
            <Link className="hot-cta" href="/hot?range=all">
              跳转总榜 →
            </Link>
            <Link className="hot-cta ghost" href="/studio">
              去创作台首发 →
            </Link>
          </div>
        </div>
      ) : (
        <ol className="hot-list">
          {rows.map((a, i) => {
            const heat = heatOf(a);
            const pct = heat === 0 ? 0 : Math.max(4, Math.round((heat / maxHeat) * 100));
            const rank = i + 1;
            return (
              <li key={a.slug} className={"hot-row" + (i < 3 ? " top" : "")}>
                <span className={"hr-rank" + (i < 3 ? ` m${rank}` : "")} aria-label={`第 ${rank} 名`}>
                  {rank < 10 ? `0${rank}` : rank}
                </span>

                <div className="hr-main">
                  <Link href={`/article/${a.slug}`} className="hr-title">
                    {a.title}
                    {a.boostUntil && <i className="hr-boost">加热中</i>}
                  </Link>

                  <div className="hr-meta">
                    <span className="hr-author">{a.author}</span>
                    <span>{a.publishedAt}</span>
                    <span>{a.readCount > 0 ? <b>{a.readCount.toLocaleString()}</b> : 0} 阅读</span>
                    <span>{(a.likeCount ?? 0) > 0 ? <b>{a.likeCount}</b> : 0} 赞</span>
                    <span>{a.commentCount > 0 ? <b>{a.commentCount}</b> : 0} 评</span>
                    {a.tipTotal ? <span className="hr-tip">赏 {a.tipTotal}</span> : null}
                  </div>

                  {/* 墨迹热度计：刻度轨 + 实测条，零热度走虚线空态 */}
                  <span className={"hr-meter" + (heat === 0 ? " zero" : "")} aria-hidden="true">
                    <span className="hr-meter-fill" style={{ width: `${pct}%` }} />
                  </span>
                </div>

                <span className={"hr-heat" + (heat === 0 ? " zero" : "")} title="热度值">
                  {heat.toLocaleString()}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {/* 榜单脚注带：给页面收口，同时把「下一站」摆到眼前 */}
      <footer className="hot-foot">
        <div className="hf-note">
          <b>榜单说明</b>
          <p>
            热度是「影响力」的近似值，不是 PV 排行：一次分身问答（×10）比一次浏览（×1）更能说明一篇文章被真实用上了。
            时间窗按刊出日期归档，同一篇文章在不同档位名次会浮动。
          </p>
        </div>
        <div className="hf-acts">
          <Link className="hf-cta" href="/weekly">
            <i aria-hidden="true">报</i>
            <span className="hf-body">
              <b>每周墨报</b>
              <small>一周精选合订本</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/search">
            <i aria-hidden="true">检</i>
            <span className="hf-body">
              <b>全站检索</b>
              <small>按题名 / 摘要定位</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/studio">
            <i aria-hidden="true">写</i>
            <span className="hf-body">
              <b>上版写作</b>
              <small>发布即有分身陪读</small>
            </span>
          </Link>
        </div>
      </footer>
    </div>
  );
}
