"use client";

// 书房 · 专栏管理器：开专栏 / 订篇目（上下移序）/ 改题名简介 / 删专栏
// 篇目只能收自己「已发布且过审」的文章；保存时整体重排（PATCH slugs 数组）
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MySeries, SeriesTitleSuggestion } from "@/lib/data";

type Props = {
  initial: MySeries[];
  myArticles: { slug: string; title: string }[];
  /** 题名建议：服务端按已过审文章标签聚合生成 */
  suggestions?: SeriesTitleSuggestion[];
};

export default function SeriesManager({ initial, myArticles, suggestions = [] }: Props) {
  const router = useRouter();
  const [series, setSeries] = useState<MySeries[]>(initial);
  const [openId, setOpenId] = useState<number | null>(initial[0]?.id ?? null);
  const [drafts, setDrafts] = useState<Record<number, MySeries>>({});
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  function flash(ok: string, error = "") {
    setMsg(ok);
    setErr(error);
    if (ok || error) setTimeout(() => { setMsg(""); setErr(""); }, 2600);
  }

  /** 当前编辑草稿（未保存的本地改动） */
  function draftOf(s: MySeries): MySeries {
    return drafts[s.id] ?? s;
  }
  function edit(s: MySeries, patch: Partial<MySeries>) {
    setDrafts((d) => ({ ...d, [s.id]: { ...draftOf(s), ...patch } }));
  }

  async function create() {
    if (busy) return;
    const title = newTitle.trim();
    if (title.length < 2) return flash("", "专栏题名至少 2 个字");
    setBusy("create");
    try {
      const res = await fetch("/api/series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description: newDesc.trim() }),
      });
      const d = (await res.json()) as { ok?: boolean; id?: number; error?: string };
      if (!res.ok || !d.ok) flash("", d.error ?? "创建失败");
      else {
        setSeries((list) => [...list, { id: d.id!, title, description: newDesc.trim(), bundlePrice: null, items: [] }]);
        setNewTitle("");
        setNewDesc("");
        setOpenId(d.id!);
        flash("专栏已开张，去订篇目吧");
        router.refresh();
      }
    } catch {
      flash("", "网络异常");
    } finally {
      setBusy("");
    }
  }

  async function save(s: MySeries) {
    if (busy) return;
    const d = draftOf(s);
    setBusy(`save-${s.id}`);
    try {
      const res = await fetch(`/api/series/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: d.title, description: d.description, slugs: d.items.map((x) => x.slug) }),
      });
      const r = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !r.ok) flash("", r.error ?? "保存失败");
      else {
        setSeries((list) => list.map((x) => (x.id === s.id ? d : x)));
        setDrafts(({ [s.id]: _drop, ...rest }) => rest);
        flash("专栏已保存");
        router.refresh();
      }
    } catch {
      flash("", "网络异常");
    } finally {
      setBusy("");
    }
  }

  async function remove(s: MySeries) {
    if (busy) return;
    if (!confirm(`删除专栏《${s.title}》？文章本身不受影响，仅解除订集。`)) return;
    setBusy(`del-${s.id}`);
    try {
      const res = await fetch(`/api/series/${s.id}`, { method: "DELETE" });
      const r = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !r.ok) flash("", r.error ?? "删除失败");
      else {
        setSeries((list) => list.filter((x) => x.id !== s.id));
        flash("专栏已删除");
        router.refresh();
      }
    } catch {
      flash("", "网络异常");
    } finally {
      setBusy("");
    }
  }

  /** 订篇目 / 调序（仅改本地草稿，点保存才落库） */
  function addArticle(s: MySeries, slug: string) {
    const art = myArticles.find((a) => a.slug === slug);
    if (!art) return;
    const d = draftOf(s);
    if (d.items.some((x) => x.slug === slug)) return;
    edit(s, { items: [...d.items, { slug, title: art.title }] });
  }
  function moveItem(s: MySeries, idx: number, dir: -1 | 1) {
    const d = draftOf(s);
    const next = [...d.items];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    edit(s, { items: next });
  }
  function dropItem(s: MySeries, idx: number) {
    const d = draftOf(s);
    edit(s, { items: d.items.filter((_, i) => i !== idx) });
  }

  const dirty = (s: MySeries) => drafts[s.id] !== undefined;
  const dirtyIds = new Set(Object.keys(drafts).map(Number));

  return (
    <section className="series-mgr">
      <div className="section-head">
        <h3>专栏合集</h3>
        <span className="admin-flag">把同一线脉络的文章订成一本，读者按序读</span>
      </div>

      {/* 开新专栏 */}
      <div className="sm-create">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="专栏题名（2-60 字）"
          maxLength={60}
          aria-label="专栏题名"
        />
        <input
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          placeholder="一句话卷首语（选填）"
          maxLength={100}
          aria-label="专栏简介"
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <button className="mini-btn go" disabled={!!busy} onClick={create}>
          开专栏
        </button>
      </div>
      {suggestions.length > 0 && !newTitle && (
        <div className="sm-suggests" aria-label="题名建议">
          <span className="sm-suggests-label">起名没头绪？按你的文章脉络拟了几个：</span>
          <div className="sm-suggests-row">
            {suggestions.map((s) => (
              <button key={s.title} type="button" className="sm-suggest" onClick={() => setNewTitle(s.title)} title={s.hint}>
                <i aria-hidden="true">印</i>
                <b>《{s.title}》</b>
                <small>{s.hint}</small>
              </button>
            ))}
          </div>
        </div>
      )}
      {(msg || err) && <p className={err ? "mig-error" : "adm-ok"}>{err ? `✕ ${err}` : msg}</p>}

      {series.length === 0 ? (
        <p className="sm-empty">还没有专栏。开一本，把散落的篇章串成动线。</p>
      ) : (
        <ul className="sm-list">
          {series.map((s) => {
            const d = draftOf(s);
            const open = openId === s.id;
            const remaining = myArticles.filter((a) => !d.items.some((x) => x.slug === a.slug));
            return (
              <li key={s.id} className={"sm-item" + (dirtyIds.has(s.id) ? " dirty" : "")}>
                <button className="sm-head" onClick={() => setOpenId(open ? null : s.id)} aria-expanded={open}>
                  <b className="sm-title">《{s.title}》</b>
                  <span className="sm-count">{d.items.length} 篇{dirtyIds.has(s.id) ? " · 未保存" : ""}</span>
                  <i className={"sm-caret" + (open ? " on" : "")}>▾</i>
                </button>
                {open && (
                  <div className="sm-body">
                    <div className="sm-meta-edit">
                      <input
                        value={d.title}
                        onChange={(e) => edit(s, { title: e.target.value })}
                        maxLength={60}
                        aria-label="专栏题名"
                      />
                      <input
                        value={d.description}
                        onChange={(e) => edit(s, { description: e.target.value })}
                        placeholder="一句话卷首语"
                        maxLength={100}
                        aria-label="专栏简介"
                      />
                    </div>

                    {d.items.length === 0 ? (
                      <p className="sm-hint">还没有篇目，从下面挑自己的文章订进来。</p>
                    ) : (
                      <ol className="sm-items">
                        {d.items.map((it, idx) => (
                          <li key={it.slug}>
                            <span className="sm-idx">{String(idx + 1).padStart(2, "0")}</span>
                            <span className="sm-item-title">{it.title}</span>
                            <span className="sm-ops">
                              <button title="上移" disabled={idx === 0 || !!busy} onClick={() => moveItem(s, idx, -1)}>
                                ↑
                              </button>
                              <button
                                title="下移"
                                disabled={idx === d.items.length - 1 || !!busy}
                                onClick={() => moveItem(s, idx, 1)}
                              >
                                ↓
                              </button>
                              <button title="移出" disabled={!!busy} onClick={() => dropItem(s, idx)}>
                                ✕
                              </button>
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}

                    {remaining.length > 0 && (
                      <div className="sm-add">
                        <select
                          value=""
                          aria-label="挑选文章订入专栏"
                          onChange={(e) => e.target.value && addArticle(s, e.target.value)}
                        >
                          <option value="">＋ 挑自己的已发布文章订入…</option>
                          {remaining.map((a) => (
                            <option key={a.slug} value={a.slug}>
                              {a.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="sm-foot">
                      <button className="mini-btn go" disabled={!!busy || !dirty(s)} onClick={() => save(s)}>
                        {dirty(s) ? "保存改动" : "已保存"}
                      </button>
                      <button className="mini-btn warn" disabled={!!busy} onClick={() => remove(s)}>
                        删除专栏
                      </button>
                      <a className="mini-btn" href={`/series/${s.id}`} target="_blank" rel="noopener">
                        看前台 →
                      </a>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
