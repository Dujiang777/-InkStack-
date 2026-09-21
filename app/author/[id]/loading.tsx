// 作者页加载态：按「墨者册页」真实版式占位（题签 + 墨绩签 + 墨轴挂章 + 侧栏书脊）
export default function AuthorLoading() {
  return (
    <div className="author-page" aria-busy="true" aria-live="polite">
      <header className="author-hero">
        <div className="author-hero-main">
          <span className="sk sk-seal-xl" />
          <div className="ah-text">
            <span className="sk sk-kicker" />
            <span className="sk sk-title" />
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </div>
        </div>
        <aside className="tag-plate author-plate" aria-hidden="true">
          <span className="sk sk-chip" />
          <span className="sk sk-plate-title" />
          <span className="sk sk-line" />
          <span className="sk sk-cta" />
        </aside>
        <span className="sk sk-ledger" />
      </header>

      <div className="author-body">
        <section className="author-main">
          <div className="section-head author-main-head">
            <span className="sk sk-headtitle" />
            <span className="sk sk-chip" />
          </div>
          <ol className="tag-cases" aria-hidden="true">
            {[0, 1, 2].map((i) => (
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
        </section>

        <aside className="author-side" aria-hidden="true">
          <div className="as-head">
            <span className="sk sk-headtitle" />
            <span className="sk sk-chip" />
          </div>
          <ol className="author-shelf">
            <li className="sk sk-spine" />
          </ol>
        </aside>
      </div>

      <span className="ink-visually-hidden">正在翻开墨者册页…</span>
    </div>
  );
}
