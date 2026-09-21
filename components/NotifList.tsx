"use client";

// 通知中心列表：类型筛选 + 相对时间 + 未读管理；单条点击即标记已读并跳转
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

type Notif = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
};

const ICON: Record<string, string> = { comment: "评", tip: "赏", review: "审", like: "赞", system: "系" };
const TYPE_LABEL: Record<string, string> = {
  comment: "评论",
  like: "点赞",
  tip: "打赏",
  review: "审核",
  system: "系统",
};

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "comment", label: "评论" },
  { key: "like", label: "点赞" },
  { key: "tip", label: "打赏" },
  { key: "review", label: "审核" },
  { key: "system", label: "系统" },
];

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / 具体日期 */
function relTime(s: string): string {
  const t = new Date(s.replace(" ", "T") + "+08:00").getTime();
  if (Number.isNaN(t)) return s;
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3.6e6) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 8.64e7) return `${Math.floor(diff / 3.6e6)} 小时前`;
  if (diff < 1.728e8) return "昨天";
  return s.slice(0, 10);
}

export default function NotifList() {
  const [list, setList] = useState<Notif[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState("all");
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const d = (await res.json()) as { notifications?: Notif[]; unread?: number };
      setList(d.notifications ?? []);
      setUnread(d.unread ?? 0);
    } catch {
      setList([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function markAll() {
    await fetch("/api/notifications/read", { method: "POST" }).catch(() => {});
    await load();
  }

  /** 点单条：标记已读（乐观更新）+ 跳转 */
  async function openOne(n: Notif) {
    if (!n.isRead) {
      setUnread((u) => Math.max(0, u - 1));
      setList((l) => (l ?? []).map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }
    if (n.link) router.push(n.link);
  }

  const filtered = useMemo(() => {
    if (!list) return [];
    return filter === "all" ? list : list.filter((n) => n.type === filter);
  }, [list, filter]);

  const countByType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of list ?? []) m[n.type] = (m[n.type] ?? 0) + 1;
    return m;
  }, [list]);

  if (list === null) return <p className="admin-denied">读取中…</p>;

  return (
    <div className="notif-list-page">
      {/* 筛选条 */}
      <div className="notif-filters" role="tablist" aria-label="通知类型筛选">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? list.length : (countByType[f.key] ?? 0);
          return (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={"nf-chip" + (filter === f.key ? " on" : "")}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <i>{n}</i>
            </button>
          );
        })}
        <span className="nf-spacer" aria-hidden="true" />
        {unread > 0 && (
          <button className="mini-btn" onClick={markAll}>
            全部标为已读（{unread}）
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="notif-empty-box">
          <span className="ink-seal" aria-hidden="true">
            墨
          </span>
          <b>{filter === "all" ? "信箱还是空的" : `还没有${TYPE_LABEL[filter] ?? ""}类通知`}</b>
          <p>
            {filter === "all"
              ? "收到评论、点赞、打赏或审核结果时，会第一时间送到这里。"
              : "去文章页和读者互动，或发布新文章，动静很快就会来。"}
          </p>
        </div>
      ) : (
        <ul className="notif-cards">
          {filtered.map((n) => (
            <li key={n.id} className={"notif-card" + (n.isRead ? "" : " unread")}>
              <button onClick={() => openOne(n)} type="button">
                <span className={"nicon n-" + n.type}>{ICON[n.type] ?? "·"}</span>
                <span className="ntext">
                  <b>
                    {!n.isRead && <i className="unread-dot" aria-label="未读" />}
                    {n.title}
                    <em className="ntype">{TYPE_LABEL[n.type] ?? n.type}</em>
                  </b>
                  {n.body && <small>{n.body}</small>}
                  <time>{relTime(n.createdAt)}</time>
                </span>
                <span className="ngo" aria-hidden="true">
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
