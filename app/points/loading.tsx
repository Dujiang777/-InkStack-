// 墨仓加载态：骨架屏按真实版式占位（题签 + 三张账户卡 + 四档墨锭 + 账本行），避免整页跳白
export default function PointsLoading() {
  return (
    <div className="points-page" aria-busy="true" aria-live="polite">
      <header className="points-head">
        <span className="sk sk-kicker" />
        <span className="sk sk-title" />
        <span className="sk sk-lead" />
      </header>

      <div className="points-grid" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className="sk sk-stat" />
        ))}
      </div>

      <section className="topup-section" aria-hidden="true">
        <div className="topup-head">
          <span className="sk sk-kicker" />
          <span className="sk sk-title" />
          <span className="sk sk-lead" />
        </div>
        <div className="topup-grid">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="sk sk-pack" />
          ))}
        </div>
        <div className="topup-bar">
          <span className="sk sk-line short" />
          <span className="sk sk-cta" />
        </div>
      </section>

      <div className="ledger" aria-hidden="true">
        <div className="ledger-head">
          <span className="sk sk-rowtitle" />
          <span className="sk sk-legend2" />
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="sk sk-ledger-row" />
        ))}
      </div>

      <span className="ink-visually-hidden">正在打开墨仓账本…</span>
    </div>
  );
}
