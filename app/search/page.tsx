import Link from "next/link";
import { listArticles, searchArticles, effectiveUnlockPrice, type SearchResultRow } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";

// 检索台 v3「墨谱检索」：
// - 类别筛选做成「印章墙」：每个标签一枚墨章，搜素时章面显示「命中/总量」分面计数
// - 选中章变朱砂印（印泥感），可再点一次或点「全部」取消
// - 无关键词时是「探索态」：墨谱 + 最新刊 / 最热读 双列
// - 结果卡保留编号+高亮，并挂标签芯片直通话题页
function Highlight({ text, kw }: { text: string; kw: string }) {
  const k = kw.trim();
  if (!k) return <>{text}</>;
  const parts = text.split(new RegExp(`(${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === k.toLowerCase() ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>
      )}
    </>
  );
}

function HitFragment({ row, kw }: { row: SearchResultRow; kw: string }) {
  if (row.summary) {
    return (
      <p className="sr-summary">
        <Highlight text={row.summary.slice(0, 120)} kw={kw} />
      </p>
    );
  }
  if (row.hit) {
    return (
      <p className="sr-summary">
        …<Highlight text={row.hit} kw={kw} />…
      </p>
    );
  }
  return null;
}

const SORTS: { key: string; label: string }[] = [
  { key: "relevance", label: "最相关" },
  { key: "new", label: "最新" },
  { key: "hot", label: "最热" },
];

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; tag?: string; paid?: string }>;
}) {
  const { q, sort: sortRaw, tag: tagRaw, paid: paidRaw } = await searchParams;
  const kw = (q ?? "").trim();
  const sort = SORTS.some((s) => s.key === sortRaw) ? (sortRaw as string) : "relevance";
  const tag = (tagRaw ?? "").trim() || null;
  const paid = paidRaw === "1";

  const searching = kw.length >= 2;
  // v17.2：付费墙纵深——已登录访客若已购买某篇付费文，该文正文仍可被检索到
  const viewer = await getCurrentUser();
  const rows = searching ? await searchArticles(kw, 50, viewer?.id ?? null) : [];

  // 全站标签总量（墨章的「共 Y」底数 + 探索态的章面计数）
  const all = await listArticles();
  const corpusFreq = new Map<string, number>();
  for (const a of all) for (const t of a.tags) corpusFreq.set(t, (corpusFreq.get(t) ?? 0) + 1);
  const maxFreq = Math.max(1, ...corpusFreq.values());

  // 分面：检索时统计各标签在命中结果中的出现次数
  const hitFreq = new Map<string, number>();
  for (const r of rows) for (const t of r.tags) hitFreq.set(t, (hitFreq.get(t) ?? 0) + 1);
  const sealTags = [...new Set([...corpusFreq.keys(), ...(searching ? [...hitFreq.keys()] : [])])]
    .sort((x, y) => (hitFreq.get(y) ?? 0) - (hitFreq.get(x) ?? 0) || (corpusFreq.get(y) ?? 0) - (corpusFreq.get(x) ?? 0));

  // 付费专稿分面：命中数 / 全站数
  const isPaid = (a: { unlockPrice?: number }) => (a.unlockPrice ?? 0) > 0;
  const paidHits = rows.filter(isPaid).length;
  const paidTotal = all.filter(isPaid).length;

  // 类别 + 付费过滤（服务端内存过滤，语料规模小）
  const filtered = rows.filter((r) => (!tag || r.tags.includes(tag)) && (!paid || isPaid(r)));

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "new") return b.publishedAt.localeCompare(a.publishedAt);
    if (sort === "hot")
      return (
        b.readCount + b.likeCount * 5 + b.commentCount * 10 -
        (a.readCount + a.likeCount * 5 + a.commentCount * 10)
      );
    return 0;
  });

  // 探索态素材：最新 3 篇 + 最热 3 篇
  const fresh = [...all].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 3);
  const hottest = [...all]
    .sort((a, b) => b.readCount + (b.likeCount ?? 0) * 5 - (a.readCount + (a.likeCount ?? 0) * 5))
    .slice(0, 3);

  const qs = (over: { q?: string; sort?: string; tag?: string | null; paid?: string | null }) => {
    const p = new URLSearchParams();
    const vq = over.q !== undefined ? over.q : kw;
    const vs = over.sort !== undefined ? over.sort : sort;
    const vt = over.tag !== undefined ? over.tag : tag;
    const vp = over.paid !== undefined ? over.paid : paid ? "1" : null;
    if (vq) p.set("q", vq);
    if (vs && vs !== "relevance") p.set("sort", vs);
    if (vt) p.set("tag", vt);
    if (vp) p.set("paid", vp);
    const s = p.toString();
    return s ? `/search?${s}` : "/search";
  };

  return (
    <div className="search-page v3">
      {/* ---------- 搜索刊头 ---------- */}
      <section className="search-hero" aria-label="搜索">
        <span className="kicker">SEARCH · 墨谱检索台</span>
        <h1 className="search-title">
          一枚墨章一个世界<span className="st-dot">。</span>
        </h1>
        <form className="search-form big" action="/search" method="GET" role="search">
          {sort !== "relevance" && <input type="hidden" name="sort" value={sort} />}
          {tag && <input type="hidden" name="tag" value={tag} />}
          {paid && <input type="hidden" name="paid" value="1" />}
          <input
            name="q"
            defaultValue={kw}
            placeholder="搜标题、摘要、正文…（至少 2 字）"
            aria-label="搜索关键词"
            maxLength={60}
            autoFocus
          />
          <button type="submit">研墨开查</button>
        </form>
      </section>

      {/* ---------- 墨谱：印章式类别筛选 ---------- */}
      {(sealTags.length > 0 || paidTotal > 0) && (
        <section className="seal-wall" aria-label="类别筛选">
          <div className="seal-wall-head">
            <b>墨谱 · 类别</b>
            <span className="seal-hint">
              {searching ? "章面为「命中 / 全站」计数 · 点章过滤结果" : "点一枚章，直接看这个话题"}
            </span>
          </div>
          <div className="seal-grid">
            <Link
              className={"seal-chip seal-all" + (tag === null && !paid ? " on" : "")}
              href={qs({ tag: null, paid: null })}
              aria-label="全部分类"
            >
              <i>全</i>
              <b>全部</b>
              <u>{searching ? `${rows.length} 命中` : `${all.length} 篇`}</u>
            </Link>
            {paidTotal > 0 && (
              <Link
                className={"seal-chip seal-paid" + (paid ? " on" : "") + (searching && paidHits === 0 ? " dim" : "")}
                href={qs({ paid: paid ? null : "1" })}
                title={searching ? `命中 ${paidHits} 篇 · 全站 ${paidTotal} 篇` : `全站 ${paidTotal} 篇`}
              >
                <i>付</i>
                <b>付费专稿</b>
                <u>{searching ? `${paidHits} / ${paidTotal}` : `${paidTotal} 篇`}</u>
              </Link>
            )}
            {sealTags.map((t, i) => {
              const hits = hitFreq.get(t) ?? 0;
              const total = corpusFreq.get(t) ?? 0;
              const dead = searching && hits === 0;
              return (
                <Link
                  key={t}
                  className={"seal-chip" + (tag === t ? " on" : "") + (dead ? " dim" : "")}
                  style={{ ["--dens" as string]: String(0.55 + 0.45 * (total / maxFreq)), ["--tilt" as string]: `${i % 2 === 0 ? -1.2 : 1.1}deg` }}
                  href={qs({ tag: tag === t ? null : t })}
                  title={searching ? `命中 ${hits} 篇 · 全站 ${total} 篇` : `全站 ${total} 篇`}
                >
                  <i>#{t.slice(0, 2)}</i>
                  <b>{t}</b>
                  <u>{searching ? `${hits} / ${total}` : `${total} 篇`}</u>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* ---------- 检索态结果 ---------- */}
      {searching && (
        <>
          <div className="section-head">
            <h2>
              「{kw}」
              {tag ? ` × ${tag}` : ""}
              {paid ? " × 付费专稿" : ""} 的 {filtered.length} 条结果
            </h2>
            <div className="sr-sorts" role="tablist" aria-label="结果排序">
              {SORTS.map((s) => (
                <Link
                  key={s.key}
                  role="tab"
                  aria-selected={sort === s.key}
                  className={"sr-sort" + (sort === s.key ? " on" : "")}
                  href={qs({ sort: s.key })}
                >
                  {s.label}
                </Link>
              ))}
            </div>
          </div>

          {sorted.length === 0 ? (
            <div className="sr-empty">
              <span className="ink-seal" aria-hidden="true">
                空白
              </span>
              <b>
                {tag
                  ? `「${kw}」在 ${tag} 话题下没有命中`
                  : `没有找到与「${kw}」相关的文章`}
              </b>
              <p>换一枚墨章或换个短关键词；或者——干脆自己写一篇，让分身陪你把它写完。</p>
              <div className="nf-ops">
                {tag && (
                  <Link className="hero-cta" href={qs({ tag: null })}>
                    清除墨章过滤 →
                  </Link>
                )}
                <Link className="hero-cta ghost" href="/studio">
                  去 AI 创作台 →
                </Link>
              </div>
            </div>
          ) : (
            <ol className="sr-cards">
              {sorted.map((r, i) => (
                <li key={r.slug} className="sr-card">
                  <span className="sr-idx" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="sr-main">
                    <h3>
                      <Link href={`/article/${r.slug}`}>
                        <Highlight text={r.title} kw={kw} />
                      </Link>
                    </h3>
                    <HitFragment row={r} kw={kw} />
                    <div className="sr-tags">
                      {(r.unlockPrice ?? 0) > 0 && <span className="tag-chip mini paid">付费 {effectiveUnlockPrice(r)}墨</span>}
                      {r.tags.map((t) => (
                        <Link key={t} className="tag-chip mini" href={`/tag/${encodeURIComponent(t)}`}>
                          #{t}
                        </Link>
                      ))}
                    </div>
                    <div className="sr-meta">
                      {r.authorId ? (
                        <Link className="meta-author" href={`/author/${r.authorId}`}>
                          {r.author}
                        </Link>
                      ) : (
                        <span>{r.author}</span>
                      )}
                      <span>{r.publishedAt}</span>
                      <span>
                        阅读 <b>{r.readCount.toLocaleString()}</b>
                      </span>
                      <span>
                        赞 <b>{r.likeCount}</b>
                      </span>
                      <span>
                        评 <b>{r.commentCount}</b>
                      </span>
                    </div>
                  </div>
                  <Link className="sr-go" href={`/article/${r.slug}`} aria-label={`阅读 ${r.title}`}>
                    阅读 →
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {/* ---------- 探索态（无关键词） ---------- */}
      {!searching && (
        <section className="explore-duo" aria-label="探索墨栈">
          <div className="explore-col">
            <b className="explore-head">最新刊</b>
            <ul>
              {fresh.map((a) => (
                <li key={a.slug}>
                  <Link href={`/article/${a.slug}`}>
                    <span className="ex-title">{a.title}</span>
                    <span className="ex-meta">
                      {a.author} · {a.publishedAt}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="explore-col">
            <b className="explore-head">最热读</b>
            <ul>
              {hottest.map((a) => (
                <li key={a.slug}>
                  <Link href={`/article/${a.slug}`}>
                    <span className="ex-title">{a.title}</span>
                    <span className="ex-meta">{a.readCount.toLocaleString()} 阅读 · 赏 {a.tipTotal ?? 0}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {kw.length > 0 && kw.length < 2 && (
        <p className="admin-denied">关键词至少 2 个字，例如「AI 写作」。</p>
      )}
    </div>
  );
}
