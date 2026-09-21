import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSeriesDetail } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import BundleUnlockBox from "@/components/BundleUnlockBox";

export const dynamic = "force-dynamic";

// 专栏落地页：卷首题签（著者 + 卷宗登记签）→ 一口价打包盒 → 卷目（墨轴挂章，壹贰叁编号）
// → 卷末收口 → 脚注带，把「按序读完一卷」的动线交代清楚。
const NO = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const s = await getSeriesDetail(Number(id));
  if (!s) return { title: "专栏不存在 · 墨栈" };
  return {
    title: `《${s.title}》 · 专栏 · 墨栈 InkStack`,
    description: s.description || `${s.author} 的专栏，共 ${s.items.length} 篇。`,
  };
}

export default async function SeriesDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const viewer = await getCurrentUser();
  const s = await getSeriesDetail(id, { id: viewer?.id ?? null });
  if (!s) notFound();
  const isOwn = viewer?.id != null && viewer.id === s.authorId;

  // 打包盒展示条件：开了打包价、浏览者非作者、还没打包买过、确实还有待解锁的付费篇
  const lockedPaid = s.items.filter((x) => x.lockedForViewer);
  const showBundle =
    s.bundlePrice !== null && !isOwn && !s.bundlePurchased && lockedPaid.length > 0 && s.bundlePrice < s.fullPrice;

  const total = s.items.length;
  const readTotal = s.items.reduce((n, x) => n + x.readCount, 0);
  const payable = s.items.filter((x) => (x.unlockPrice ?? 0) > 0).length;
  const readable = s.items.filter((x) => !x.lockedForViewer).length;
  const pct = total > 0 ? Math.max(readable > 0 ? 4 : 0, Math.round((readable / total) * 100)) : 0;

  return (
    <div className="series-page series-landing">
      {/* ── 一 · 卷首题签 ── */}
      <header className="sd-head">
        <div className="sd-head-main">
          <p className="sd-kicker">
            <span className="sd-kicker-lat">COLUMN</span>
            <i aria-hidden="true">／</i>
            <Link href={`/author/${s.authorId}`} className="sd-author">
              {s.author}
            </Link>
            <i>的专栏</i>
          </p>
          <h1 className="sd-title">
            <span className="sd-quote" aria-hidden="true">
              《
            </span>
            <span className="sd-name">{s.title}</span>
            <span className="sd-quote" aria-hidden="true">
              》
            </span>
          </h1>
          {s.description && <p className="sd-sub">{s.description}</p>}

          <div className="sd-strip">
            <span className="sd-ava" aria-hidden="true">
              {s.authorAvatar}
            </span>
            <span className="sd-byline">
              著者 <b>{s.author}</b>
            </span>
            <span className="sd-sep" aria-hidden="true" />
            <span className="sd-count">
              共 <b>{total}</b> 篇
            </span>
            <span className="sd-count">
              累计 <b>{readTotal.toLocaleString()}</b> 阅读
            </span>
            {s.soldCount > 0 && (
              <span className="sd-count on">
                打包 <b>{s.soldCount.toLocaleString()}</b> 篇次
              </span>
            )}
          </div>
        </div>

        <aside className="sd-plate">
          <span className="sd-plabel">卷 · COLUMN</span>
          <div className="sd-total">
            <b>{total}</b>
            <i>篇</i>
          </div>
          <span className="sd-prule" aria-hidden="true" />
          <div className="sd-gauge">
            <span className="sd-gauge-label">可 读</span>
            <span className="sd-gauge-bar" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="sd-gauge-num">
              {readable}
              <em>/{total}</em>
            </span>
          </div>
          <div className="sd-figs">
            <span className={`sd-cell${readTotal > 0 ? " on" : ""}`}>
              <b>{readTotal > 0 ? readTotal.toLocaleString() : "—"}</b>
              <i>累计阅读</i>
            </span>
            <span className={`sd-cell${payable > 0 ? " on" : ""}`}>
              <b>{payable > 0 ? payable : "—"}</b>
              <i>付费专稿</i>
            </span>
          </div>
        </aside>
      </header>

      {/* ── 二 · 一口价打包盒 ── */}
      {showBundle && (
        <BundleUnlockBox
          seriesId={s.id}
          price={s.bundlePrice!}
          fullPrice={s.fullPrice}
          paidCount={lockedPaid.length}
          loggedIn={Boolean(viewer)}
          balance={viewer?.points ?? null}
          soldCount={s.soldCount}
        />
      )}
      {s.bundlePurchased && (
        <p className="sd-owned">
          <i aria-hidden="true">✦</i>本卷已打包入手，全部篇目任你读
        </p>
      )}

      {/* ── 三 · 卷目 ── */}
      <section className="sd-dossier">
        <div className="sd-dossier-head">
          <h2>卷 目</h2>
          <span className="sd-dossier-note">
            {payable > 0 ? `${payable} 篇付费专稿 · 其余免费通读` : "全部免费通读"}
          </span>
        </div>

        {total === 0 ? (
          isOwn ? (
            <div className="sd-empty own">
              <span className="sd-eseal" aria-hidden="true">
                空柜
              </span>
              <b>这本柜子立好了，还空着</b>
              <ol className="sd-steps">
                <li>回书房 · 专栏管理，从你「已发布且过审」的文章里挑篇目订进来；</li>
                <li>篇目建议 4 篇起步，成柜后读者才有「按序读完」的动线；</li>
                <li>想整柜卖就设个打包价（一口价），不打包也只按篇解锁。</li>
              </ol>
              <Link className="sd-cta" href="/study">
                去书房布置 →
              </Link>
            </div>
          ) : (
            <div className="sd-empty">
              <span className="sd-eseal" aria-hidden="true">
                待编
              </span>
              <b>博主正在筹备这一卷</b>
              <p>篇目已在选定中，过审发布后就会出现在这里。可以先去合集架逛逛别的。</p>
              <Link className="sd-cta" href="/series">
                回合集架 →
              </Link>
            </div>
          )
        ) : (
          <>
            <ol className="sd-list">
              {s.items.map((it, i) => (
                <li key={it.slug} className={`sd-row${it.lockedForViewer ? " locked" : ""}`}>
                  <span className="sd-axis" aria-hidden="true">
                    <i className="sd-no">{NO[i] ?? i + 1}</i>
                  </span>
                  <div className="sd-body">
                    <span className="sd-reg">
                      <i>NO.</i>
                      {String(i + 1).padStart(2, "0")}
                      <em aria-hidden="true">·</em>
                      {it.publishedAt || "未注日期"}
                    </span>
                    <Link href={`/article/${it.slug}`} className="sd-rtitle">
                      {it.title}
                    </Link>
                    <span className="sd-meta">
                      <b>{it.readCount.toLocaleString()}</b> 阅读
                    </span>
                  </div>
                  {it.lockedForViewer ? (
                    <span className="sd-lock" title="付费专稿，需解锁">
                      <i aria-hidden="true">锁</i>
                      {it.unlockPrice} 点
                    </span>
                  ) : (it.unlockPrice ?? 0) > 0 ? (
                    <span className="sd-lock owned">
                      <i aria-hidden="true">✓</i>已解锁
                    </span>
                  ) : (
                    <span className="sd-lock free">免 费</span>
                  )}
                </li>
              ))}
            </ol>
            <span className="sd-end" aria-hidden="true">
              <i className="sd-end-line" />
              <b>卷 终</b>
              <i className="sd-end-line" />
            </span>
          </>
        )}
      </section>

      {/* ── 四 · 脚注带：把页尾的死白换成三条去路 ── */}
      <footer className="sd-foot">
        <div className="hf-note">
          <b>读一卷的规矩</b>
          <p>
            专栏按序编号，篇目由著者订入并逐一过审。付费专稿可单篇解锁，也可整卷一口价打包；
            已单买过的篇目在打包时自动折抵，不重复计费。
          </p>
        </div>
        <div className="hf-acts">
          <Link className="hf-cta" href="/series">
            <i aria-hidden="true">卷</i>
            <span className="hf-body">
              <b>回合集架</b>
              <small>逛逛别的作者立的柜</small>
            </span>
          </Link>
          <Link className="hf-cta" href={`/author/${s.authorId}`}>
            <i aria-hidden="true">著</i>
            <span className="hf-body">
              <b>{s.author} 的册页</b>
              <small>看这位墨者的全部存稿</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/points">
            <i aria-hidden="true">墨</i>
            <span className="hf-body">
              <b>去墨仓</b>
              <small>备足墨点再开卷</small>
            </span>
          </Link>
        </div>
      </footer>
    </div>
  );
}
