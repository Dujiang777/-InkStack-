import Link from "next/link";

// 404：墨渍溅页 —— 保持纸墨语言，给三条出路（头版 / 漫游 / 搜索）
export default function NotFound() {
  return (
    <div className="nf-page">
      <div className="nf-card">
        <svg className="nf-ink" viewBox="0 0 680 200" role="img" aria-label="一滴溅开的墨">
          <ellipse cx="330" cy="120" rx="72" ry="56" fill="currentColor" opacity="0.92" />
          <ellipse cx="410" cy="88" rx="20" ry="15" fill="currentColor" opacity="0.7" />
          <ellipse cx="440" cy="66" rx="9" ry="7" fill="currentColor" opacity="0.55" />
          <ellipse cx="252" cy="86" rx="14" ry="10" fill="currentColor" opacity="0.6" />
          <text x="330" y="140" textAnchor="middle" className="nf-num">404</text>
        </svg>
        <h1>这一页被墨渍吃掉了</h1>
        <p>你要找的文章可能改了名、还没过审，或者从来没存在过。</p>
        <div className="nf-ops">
          <Link className="hero-cta" href="/">
            回头版
          </Link>
          <Link className="hero-cta ghost" href="/random">
            漫游读一篇 →
          </Link>
          <Link className="hero-cta ghost" href="/search?q=">
            全站检索
          </Link>
        </div>
      </div>
    </div>
  );
}
