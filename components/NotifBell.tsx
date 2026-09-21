"use client";

// 顶栏通知铃铛：未读徽标 + 下拉最近通知；30s 轮询，点开即拉新
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Notif = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
};

const ICON: Record<string, string> = {
  comment: "评",
  tip: "赏",
  review: "审",
  like: "赞",
  system: "系",
};

export default function NotifBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [list, setList] = useState<Notif[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const d = (await res.json()) as { notifications?: Notif[]; unread?: number };
      setUnread(d.unread ?? 0);
      setList(d.notifications ?? []);
    } catch {
      /* 静默 */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function markAll() {
    await fetch("/api/notifications/read", { method: "POST" }).catch(() => {});
    await load();
    router.refresh();
  }

  /** 点单条：立即标记已读（本地未读数即时衰减）+ 跳转链接 */
  async function openOne(n: Notif) {
    setOpen(false);
    if (!n.isRead) {
      // 乐观更新：未读数与列表立刻反映，失败由下次轮询兜底
      setUnread((u) => Math.max(0, u - 1));
      setList((l) => l.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }
    if (n.link) router.push(n.link);
    else router.push("/notifications");
  }

  return (
    <div className="notif-bell" ref={boxRef}>
      <button
        className="bell-btn"
        aria-label={unread > 0 ? `通知，${unread} 条未读` : "通知"}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) load();
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.3l-1.6 3A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.7L18 12.3V9a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        <span className="bell-label">通知</span>
        {unread > 0 && <i className="bell-dot">{unread > 9 ? "9+" : unread}</i>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="通知列表">
          <div className="notif-head">
            <b>通知</b>
            {unread > 0 && (
              <button className="notif-readall" onClick={markAll}>
                全部已读
              </button>
            )}
          </div>
          {list.length === 0 ? (
            <p className="notif-empty">还没有通知。收到评论、打赏或审核结果时会出现在这里。</p>
          ) : (
            <ul>
              {list.slice(0, 8).map((n) => (
                <li key={n.id} className={n.isRead ? "" : "unread"}>
                  <button onClick={() => openOne(n)}>
                    <span className={"nicon n-" + n.type}>{ICON[n.type] ?? "·"}</span>
                    <span className="ntext">
                      <b>{n.title}</b>
                      {n.body && <small>{n.body}</small>}
                      <time>{n.createdAt}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <a className="notif-all" href="/notifications">
            查看全部 →
          </a>
        </div>
      )}
    </div>
  );
}
