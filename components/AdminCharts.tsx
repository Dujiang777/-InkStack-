// 管理大盘图表：纯 SVG/CSS 渲染，不引第三方图表库
// 由 AdminConsole（client）引入，全部为无状态渲染
import type { AdminInsights } from "@/lib/data";

const C_ACCENT = "#b3412f"; // 朱砂
const C_INKBLUE = "#33566b"; // 墨青
const C_GOLD = "#a8842c"; // 赭金
const C_MUTED = "#8a8577";
const C_RULE = "#e3ddcf";

/* ---------- 近 14 天趋势：发文柱 + 评论折线 + 注册点 ---------- */
function TrendChart({ days }: { days: AdminInsights["days"] }) {
  const W = 660;
  const H = 230;
  const P = { t: 18, r: 14, b: 30, l: 34 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  const n = days.length;
  const maxVal = Math.max(3, ...days.map((d) => Math.max(d.articles, d.users, d.comments)));
  const y = (v: number) => P.t + ih - (v / maxVal) * ih;
  const slot = iw / n;
  const cx = (i: number) => P.l + slot * i + slot / 2;
  const bw = Math.min(20, slot * 0.42);

  const linePts = days.map((d, i) => `${cx(i)},${y(d.comments)}`).join(" ");
  const gridVals = Array.from({ length: maxVal + 1 }, (_, i) => i).filter(
    (v) => maxVal <= 5 || v % Math.ceil(maxVal / 5) === 0
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="近 14 天发文、评论与注册趋势">
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={P.l} y1={y(v)} x2={W - P.r} y2={y(v)} stroke={C_RULE} strokeWidth="1" strokeDasharray={v === 0 ? "0" : "3 4"} />
          <text x={P.l - 7} y={y(v) + 4} textAnchor="end" className="chart-tick">{v}</text>
        </g>
      ))}
      {days.map((d, i) => (
        <g key={d.d}>
          {/* 发文柱 */}
          {d.articles > 0 && (
            <rect
              x={cx(i) - bw / 2}
              y={y(d.articles)}
              width={bw}
              height={P.t + ih - y(d.articles)}
              rx="3"
              style={{ fill: "var(--chart-bar, #b3412f)" }}
              opacity="0.92"
            />
          )}
          {d.articles > 0 && d.articles <= maxVal && (
            <text x={cx(i)} y={y(d.articles) - 5} textAnchor="middle" className="chart-tick chart-tick-hot">
              {d.articles}
            </text>
          )}
          <text x={cx(i)} y={H - 9} textAnchor="middle" className="chart-tick">
            {i % 2 === 0 ? d.label : ""}
          </text>
        </g>
      ))}
      {/* 评论折线 */}
      <polyline points={linePts} fill="none" style={{ stroke: "var(--chart-line, #33566b)" }} strokeWidth="1.6" opacity="0.9" />
      {days.map((d, i) => (
        <circle key={"c" + d.d} cx={cx(i)} cy={y(d.comments)} r={d.comments > 0 ? 3.2 : 2} style={{ fill: "var(--chart-line, #33566b)" }} opacity={d.comments > 0 ? 0.95 : 0.35} />
      ))}
      {/* 注册散点（上方小菱形） */}
      {days.map((d, i) =>
        d.users > 0 ? (
          <g key={"u" + d.d}>
            <rect
              x={cx(i) - 3.4}
              y={y(d.users) - 3.4}
              width="6.8"
              height="6.8"
              transform={`rotate(45 ${cx(i)} ${y(d.users)})`}
              style={{ fill: "var(--chart-gold, #a8842c)" }}
            />
          </g>
        ) : null
      )}
    </svg>
  );
}

/* ---------- 墨水经济：充值 vs 打赏流向横条 ---------- */
function InkFlow({ ink }: { ink: AdminInsights["ink"] }) {
  const rows = [
    { label: "充值到账", v: ink.topupTotal, sub: `${ink.topupCount} 笔`, color: C_INKBLUE },
    { label: "打赏流水", v: ink.tipTotal, sub: `${ink.tipCount} 笔`, color: C_ACCENT },
    { label: "作者分成 90%", v: ink.authorGot, sub: "进入墨仓", color: C_GOLD },
    { label: "平台留存 10%", v: Math.max(0, ink.tipTotal - ink.authorGot), sub: "墨水循环基金", color: C_MUTED },
  ];
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <div className="inkflow">
      {rows.map((r) => (
        <div className="inkflow-row" key={r.label}>
          <span className="inkflow-label">{r.label}</span>
          <span className="inkflow-track">
            <span
              className="inkflow-bar"
              style={{ width: `${Math.max(r.v > 0 ? 3 : 0, (r.v / max) * 100)}%`, background: r.color }}
            />
          </span>
          <span className="inkflow-val">
            {r.v.toLocaleString()} <i>滴</i>
          </span>
          <span className="inkflow-sub">{r.sub}</span>
        </div>
      ))}
      <p className="inkflow-note">
        分身问答累计 {ink.qaCount.toLocaleString()} 次 · 每问扣 5 滴，问答消耗 ≈ {Math.round(ink.qaCount * 5).toLocaleString()} 滴
      </p>
    </div>
  );
}

/* ---------- 热门文章 TOP5：阅读量横条 ---------- */
function TopArticles({ rows }: { rows: AdminInsights["topArticles"] }) {
  if (rows.length === 0) return <p className="admin-denied">还没有公开文章。</p>;
  const max = Math.max(1, ...rows.map((r) => r.readCount));
  return (
    <ol className="toparts">
      {rows.map((r, i) => (
        <li key={r.slug}>
          <span className={"ta-rank" + (i < 3 ? " hot" : "")}>{String(i + 1).padStart(2, "0")}</span>
          <div className="ta-main">
            <div className="ta-line">
              <a className="ta-title" href={`/article/${r.slug}`} target="_blank" rel="noopener">
                {r.title}
              </a>
              <span className="ta-meta">
                {r.author} · {r.readCount.toLocaleString()} 阅 · {r.likeCount} 赞
                {r.tipTotal > 0 ? ` · 墨 ${r.tipTotal.toLocaleString()}` : ""}
              </span>
            </div>
            <span className="ta-track">
              <span className="ta-bar" style={{ width: `${Math.max(4, (r.readCount / max) * 100)}%` }} />
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------- 标签构成：横条 ---------- */
function TagBars({ tags }: { tags: AdminInsights["tags"] }) {
  if (tags.length === 0) return <p className="admin-denied">还没有标签数据。</p>;
  const max = Math.max(1, ...tags.map((t) => t.count));
  return (
    <div className="tagbars">
      {tags.map((t) => (
        <div className="tagbar-row" key={t.tag}>
          <span className="tagbar-name"># {t.tag}</span>
          <span className="tagbar-track">
            <span className="tagbar-bar" style={{ width: `${(t.count / max) * 100}%` }} />
          </span>
          <span className="tagbar-val">{t.count}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- 付费转化漏斗：在售稿 → 付费墙 → 单篇解锁 → 专栏打包 ---------- */
function PayFunnel({ funnel }: { funnel: AdminInsights["funnel"] }) {
  const { paidArticles, paywallViews, unlocks, bundles, revenue } = funnel;
  const emptyAll = paywallViews === 0 && unlocks === 0 && bundles === 0;
  if (emptyAll) {
    return (
      <p className="admin-denied">
        还没有付费数据{paidArticles > 0 ? `（在售付费稿 ${paidArticles} 篇，等第一位读者走到付费墙）` : "。去创作台给文章设个解锁价试试。"}
      </p>
    );
  }
  const stages = [
    { label: "付费墙到达", v: paywallViews, sub: "读到试读尽头的人数", color: C_INKBLUE },
    { label: "单篇解锁", v: unlocks, sub: "愿付真金的核心读者", color: C_ACCENT },
    { label: "专栏打包", v: bundles, sub: "整柜买走的深度粉丝", color: C_GOLD },
  ];
  const max = Math.max(1, ...stages.map((s) => s.v));
  const W = 660;
  const rowH = 46;
  const gap = 22;
  const topPad = 12;
  const leftPad = 8;
  const rightW = 150; // 右侧留给转化率标注
  const usableW = W - rightW - leftPad * 2;
  const rate = (a: number, b: number) => (a > 0 ? Math.round((b / a) * 100) : 0);
  const widthOf = (v: number) => Math.max(110, (v / max) * usableW);
  const cx = leftPad + usableW / 2;

  return (
    <div className="payfunnel">
      <svg viewBox={`0 0 ${W} ${topPad + stages.length * (rowH + gap) - gap + 8}`} className="chart-svg" role="img" aria-label="全站付费转化漏斗">
        {stages.map((s, i) => {
          const w = widthOf(s.v);
          const y = topPad + i * (rowH + gap);
          const barH = rowH - 10;
          const prev = i > 0 ? stages[i - 1].v : 0;
          const prevW = i > 0 ? widthOf(prev) : 0;
          const prevBottom = y - gap;
          const conv = i > 0 ? rate(prev, s.v) : null;
          return (
            <g key={s.label}>
              {/* 上一层收窄到本层的连接梯形 */}
              {i > 0 && (
                <path
                  d={`M ${cx - prevW / 2} ${prevBottom} L ${cx + prevW / 2} ${prevBottom} L ${cx + w / 2} ${y} L ${cx - w / 2} ${y} Z`}
                  fill={s.color}
                  opacity="0.14"
                />
              )}
              <rect x={cx - w / 2} y={y} width={w} height={barH} rx="9" fill={s.color} opacity="0.92" />
              <text x={cx} y={y + 19} textAnchor="middle" className="pf-stage-name">
                {s.label}
              </text>
              <text x={cx} y={y + 33} textAnchor="middle" className="pf-stage-sub">
                {s.sub}
              </text>
              <text x={W - rightW + 6} y={y + barH / 2 + 5} className={"pf-conv" + (conv !== null && conv >= 20 ? " hot" : "")}>
                {i === 0 ? `在售 ${paidArticles} 篇` : `转化 ${conv}%`}
              </text>
              <text x={W - rightW + 6} y={y + barH / 2 + 19} className="pf-conv-num">
                {s.v.toLocaleString()}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="pf-note">
        累计流水 <b>{revenue.toLocaleString()}</b> 点墨 · 单篇转化率 <b>{rate(paywallViews, unlocks)}%</b>
        {bundles > 0 && (
          <>
            {" "}· 打包转化率 <b>{rate(unlocks, bundles)}%</b>
          </>
        )}
      </p>
    </div>
  );
}

/* ---------- 组合 ---------- */
export default function AdminCharts({ insights }: { insights: AdminInsights }) {
  const { days, ink, topArticles, tags, funnel } = insights;
  const sum = (k: "articles" | "users" | "comments") => days.reduce((s, d) => s + d[k], 0);
  return (
    <div className="adm-charts">
      <section className="chart-card chart-wide">
        <div className="chart-head">
          <b>近 14 天 · 内容与用户趋势</b>
          <span className="chart-legend">
            <i className="lg lg-bar" /> 发文 {sum("articles")}
            <i className="lg lg-line" /> 评论 {sum("comments")}
            <i className="lg lg-dot" /> 注册 {sum("users")}
          </span>
        </div>
        <TrendChart days={days} />
      </section>

      <div className="chart-duo">
        <section className="chart-card">
          <div className="chart-head">
            <b>墨水经济</b>
            <span className="chart-legend">全站流水与分成</span>
          </div>
          <InkFlow ink={ink} />
        </section>
        <section className="chart-card">
          <div className="chart-head">
            <b>标签构成</b>
            <span className="chart-legend">公开文章 TOP8</span>
          </div>
          <TagBars tags={tags} />
        </section>
      </div>

      <section className="chart-card chart-wide">
        <div className="chart-head">
          <b>付费转化漏斗</b>
          <span className="chart-legend">从付费墙到真金流水</span>
        </div>
        <PayFunnel funnel={funnel} />
      </section>

      <section className="chart-card chart-wide">
        <div className="chart-head">
          <b>热门文章 TOP5</b>
          <span className="chart-legend">按累计阅读排序</span>
        </div>
        <TopArticles rows={topArticles} />
      </section>
    </div>
  );
}
