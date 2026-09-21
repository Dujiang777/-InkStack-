"use client";

// 文章页 · 作者快捷入柜：勾选我的专栏即收进/移出（PATCH slugs 全量保存，服务端校验归属与过审）
import { useState } from "react";

type PickSeries = { id: number; title: string; items: string[] };

export default function SeriesPicker({ slug, series }: { slug: string; series: PickSeries[] }) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<PickSeries[]>(series);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [tip, setTip] = useState("");

  function flash(msg: string) {
    setTip(msg);
    setTimeout(() => setTip(""), 2200);
  }

  async function toggle(s: PickSeries) {
    if (busyId) return;
    setBusyId(s.id);
    const has = s.items.includes(slug);
    const nextItems = has ? s.items.filter((x) => x !== slug) : [...s.items, slug];
    try {
      const res = await fetch(`/api/series/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slugs: nextItems }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && d.ok) {
        setLocal((ls) => ls.map((x) => (x.id === s.id ? { ...x, items: nextItems } : x)));
        flash(has ? `已移出《${s.title}》` : `已收进《${s.title}》`);
      } else {
        flash(d.error ?? "操作失败，请稍后再试");
      }
    } catch {
      flash("网络异常，请稍后再试");
    } finally {
      setBusyId(null);
    }
  }

  const inCount = local.filter((s) => s.items.includes(slug)).length;

  return (
    <section className="series-picker" aria-label="收进专栏">
      <button className="sp-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className="sp-ico" aria-hidden="true">
          柜
        </i>
        <span className="sp-label">
          书柜速递 · 本文已在 <b>{inCount}</b> 本专栏
        </span>
        <span className="sp-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="sp-panel">
          {local.length === 0 ? (
            <p className="sp-none">
              名下还没有专栏。先去书房开一本，再回来把这篇订进去。
            </p>
          ) : (
            <ul className="sp-list">
              {local.map((s) => {
                const on = s.items.includes(slug);
                return (
                  <li key={s.id}>
                    <label
                      className={"sp-row" + (on ? " on" : "") + (busyId === s.id ? " busy" : "")}
                      title={on ? "点击移出这本专栏" : "点击收进这本专栏"}
                    >
                      <input type="checkbox" checked={on} disabled={!!busyId} onChange={() => toggle(s)} />
                      <b className="sp-name">《{s.title}》</b>
                      <small>{s.items.length} 篇{on ? " · 已在柜" : ""}</small>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {tip && <p className="sp-tip">{tip}</p>}
        </div>
      )}
    </section>
  );
}
