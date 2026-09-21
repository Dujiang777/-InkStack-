import Link from "next/link";
import type { Metadata } from "next";
import { listSeries } from "@/lib/data";

export const metadata: Metadata = {
  title: "专栏合集 · 墨栈 InkStack",
  description: "墨栈专栏合集：把散落的篇章串成一条完整的阅读动线。",
};

export const dynamic = "force-dynamic";

// 合集架：杂志「专栏目录」版式——编号题签 + 朱砂篇数章
const NO = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];

export default async function SeriesPage() {
  const series = await listSeries();

  return (
    <div className="series-page">
      <header className="series-hero">
        <p className="series-kicker">INKSTACK · COLUMN</p>
        <h1 className="series-title">专栏合集</h1>
        <p className="series-sub">
          好文章不是孤岛。作者把同一脉络的篇章订成一本，按序读下去才够味——挑一本开读吧。
        </p>
      </header>

      {series.length === 0 ? (
        <div className="series-empty">
          <b>书架上还没有专栏</b>
          <p>在书房里把已发布的文章订成专栏，就会出现在这里。</p>
          <Link className="series-cta" href="/study">
            去书房开专栏 →
          </Link>
        </div>
      ) : (
        <ol className="series-shelf">
          {series.map((s, i) => (
            <li key={s.id} className="series-card">
              <span className="sc-no">{NO[i] ?? String(i + 1)}</span>
              <div className="sc-main">
                <Link href={`/series/${s.id}`} className="sc-title">
                  {s.title}
                  <i className="sc-count">{s.articleCount} 篇</i>
                </Link>
                {s.description && <p className="sc-desc">{s.description}</p>}
                <p className="sc-meta">
                  <span className="avatar" aria-hidden="true">
                    {s.authorAvatar}
                  </span>
                  <Link href={`/author/${s.authorId}`} className="sc-author">
                    {s.author}
                  </Link>
                  <span>{s.totalReads.toLocaleString()} 阅</span>
                  {s.soldCount > 0 && (
                    <span className="sc-sold" title="打包解锁篇目人次">
                      ▲ 售出 {s.soldCount.toLocaleString()} 篇次
                    </span>
                  )}
                </p>
              </div>
              <div className="sc-foot">
                {s.bundlePrice > 0 ? (
                  <span className="sc-price" title="打包一口价（墨水点）">
                    {s.bundlePrice.toLocaleString()}
                    <i>点墨 · 打包解锁</i>
                  </span>
                ) : (
                  <span className="sc-price free">
                    <i>免费连载</i>
                  </span>
                )}
                <Link href={`/series/${s.id}`} className="sc-cta">
                  翻开本辑 →
                </Link>
              </div>
            </li>
          ))}
          {/* 书架空位：不足三本时补占位，版面不留大面积空白 */}
          {series.length < 3 && (
            <li className="series-card ghost" aria-hidden="true">
              <span className="sc-no ghost-no">刊</span>
              <div className="sc-main">
                <b className="sc-ghost-title">新合集筹备中</b>
                <p className="sc-desc">下一本专栏正在墨池里酝酿——书房里把已发布文章订成专栏，就会摆上这个书架。</p>
                <Link href="/study" className="sc-cta">
                  去书房开专栏 →
                </Link>
              </div>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
