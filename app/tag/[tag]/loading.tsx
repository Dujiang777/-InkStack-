// 标签页加载态：按「话题卷宗」真实版式占位（题名 + 数据签 + 墨轴挂章），避免整页跳白
export default function TagLoading() {
  return (
    <div className="tag-page" aria-busy="true" aria-live="polite">
      <header className="tag-hero">
        <div className="tag-hero-main">
          <span className="sk sk-kicker" />
          <span className="sk sk-title" />
          <span className="sk sk-line short" />
        </div>
        <aside className="tag-plate sk-plate" aria-hidden="true">
          <span className="sk sk-chip" />
          <span className="sk sk-plate-title" />
          <span className="sk sk-line" />
        </aside>
      </header>

      <ol className="tag-cases" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li className="tag-case" key={i}>
            <div className="tc-axis">
              <span className="sk sk-no" />
            </div>
            <div className="tc-body sk-body">
              <span className="sk sk-chip" />
              <span className="sk sk-rowtitle" />
              <span className="sk sk-line" />
              <span className="sk sk-line short" />
            </div>
          </li>
        ))}
      </ol>
      <span className="ink-visually-hidden">正在整理话题卷宗…</span>
    </div>
  );
}
