// 专栏详情加载态：按「开卷」真实版式占位（卷首题签 + 卷宗签 + 契约条 + 墨轴卷目）
export default function SeriesDetailLoading() {
  return (
    <div className="series-page series-landing" aria-busy="true" aria-live="polite">
      <header className="sd-head">
        <div className="sd-head-main">
          <span className="sk sk-kicker" />
          <span className="sk sk-title" />
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
          <span className="sk sk-strip" />
        </div>
        <aside className="sd-plate" aria-hidden="true">
          <span className="sk sk-chip" />
          <span className="sk sk-plate-title" />
          <span className="sk sk-line" />
          <span className="sk sk-gauge" />
        </aside>
      </header>

      {/* 契约条按真实两栏骨架占位，避免整块灰砖，也让加载完成时的高度基本对得上 */}
      <section className="bundle-box" aria-hidden="true">
        <div className="bb-left">
          <span className="sk sk-chip" />
          <span className="sk sk-plate-title" />
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
        <div className="bb-deal">
          <span className="sk sk-chip" />
          <span className="sk sk-plate-title" />
          <span className="sk sk-cta" />
        </div>
      </section>

      <section className="sd-dossier">
        <div className="sd-dossier-head" aria-hidden="true">
          <span className="sk sk-headtitle" />
          <span className="sk sk-chip" />
        </div>
        <ol className="sd-list" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li className="sd-row" key={i}>
              <span className="sd-axis">
                <span className="sk sk-no" />
              </span>
              <div className="sd-body">
                <span className="sk sk-chip" />
                <span className="sk sk-rowtitle" />
                <span className="sk sk-line short" />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <span className="ink-visually-hidden">正在开卷…</span>
    </div>
  );
}
