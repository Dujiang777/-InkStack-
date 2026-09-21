// 页脚 v2：三栏（品牌口号 / 站点导航 / 说明），墨点分隔，杂志尾版语言
const COLS: { head: string; links: { href: string; label: string }[] }[] = [
  {
    head: "阅读",
    links: [
      { href: "/", label: "本期头版" },
      { href: "/hot", label: "热榜" },
      { href: "/weekly", label: "每周墨报" },
      { href: "/article/shou-xie-promise", label: "文章 × 分身" },
      { href: "/series", label: "专栏合集" },
      { href: "/search?q=", label: "全站检索" },
      { href: "/feed.xml", label: "RSS 订阅 ↗" },
    ],
  },
  {
    head: "创作",
    links: [
      { href: "/studio", label: "AI 创作台" },
      { href: "/study", label: "我的书房" },
      { href: "/import", label: "迁移工坊" },
    ],
  },
  {
    head: "账户",
    links: [
      { href: "/me", label: "个人中心" },
      { href: "/points", label: "墨仓 · 墨水账户" },
      { href: "/notifications", label: "通知中心" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="footer footer-v2">
      <div className="foot-grid">
        <div className="foot-brand-col">
          <span className="seal seal-sm" aria-hidden="true">
            墨栈
          </span>
          <b className="foot-name">墨栈 InkStack</b>
          <p className="foot-slogan">AI 原生博客平台 —— 你的文章有生命，你的分身会说话。</p>
          <p className="foot-meta">分身回答由 AI 生成并标注来源 · 创作者保留最终解释权</p>
        </div>
        {COLS.map((c) => (
          <nav key={c.head} className="foot-col" aria-label={c.head}>
            <b>{c.head}</b>
            <ul>
              {c.links.map((l) => (
                <li key={l.href + l.label}>
                  <a href={l.href}>{l.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="foot-base">
        <span>© 2026 墨栈 InkStack · 创刊号 VOL.01</span>
        <span className="foot-kbd">
          键盘暗号：<kbd>/</kbd> 搜索 · <kbd>R</kbd> 漫游 · <kbd>T</kbd> 夜读 · <kbd>?</kbd> 更多
        </span>
        <span className="foot-dots" aria-hidden="true">
          · · ·
        </span>
        <span>内容需经审核发布 · 请理性使用打赏与加热</span>
      </div>
    </footer>
  );
}
