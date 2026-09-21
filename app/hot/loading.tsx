// 热榜页加载态：骨架屏按真实版式占位（题签 + 权重条 + 名次行），避免整页跳白
export default function HotLoading() {
  return (
    <div className="hot-page" aria-busy="true" aria-live="polite">
      <header className="hot-hero">
        <div className="hot-hero-main">
          <span className="sk sk-kicker" />
          <span className="sk sk-title" />
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
        <aside className="hot-plate sk-plate">
          <span className="sk sk-chip" />
          <span className="sk sk-plate-title" />
          <span className="sk sk-fig" />
        </aside>
      </header>

      <ul className="hot-legend" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="sk-legend">
            <span className="sk sk-chip" />
          </li>
        ))}
      </ul>

      <div className="hot-tabs sk-tabs" aria-hidden="true">
        <span className="sk sk-tab" />
        <span className="sk sk-tab" />
        <span className="sk sk-tab" />
      </div>

      <ol className="hot-list" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className={"hot-row sk-row" + (i < 3 ? " top" : "")}>
            <span className={"sk sk-rank" + (i < 3 ? " m" : "")} />
            <div className="hr-main">
              <span className="sk sk-rowtitle" />
              <span className="sk sk-line short" />
              <span className="sk sk-meter" />
            </div>
            <span className="sk sk-heat" />
          </li>
        ))}
      </ol>
      <span className="ink-visually-hidden">正在重算热度榜单…</span>
    </div>
  );
}
