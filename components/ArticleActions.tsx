"use client";

// 文章页动作条（正文末尾，"打赏放下面"）：
// - 点赞：所有登录用户（作者不可赞自己），toggle 同步计数
// - 作者本人：「加热 +24h（80 墨）」按钮，可叠加延长
// - 已登录读者：「打赏墨水」10/50 两档，作者得 90%
// - 游客：展示点赞数与提示，引导登录
import { useState } from "react";
import { useRouter } from "next/navigation";
import InkBurst from "./InkBurst";

type Props = {
  slug: string;
  authorId: number;
  viewerId: number | null;
  boostUntil: string | null;
  tipTotal: number;
  likeCount: number;
  liked: boolean;
  bookmarked: boolean;
};

function fmt(until: string): string {
  const d = new Date(until);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours()
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function ArticleActions({
  slug,
  authorId,
  viewerId,
  boostUntil,
  tipTotal,
  likeCount,
  liked,
  bookmarked,
}: Props) {
  const router = useRouter();
  const [boosted, setBoosted] = useState<string | null>(boostUntil);
  const [tips, setTips] = useState(tipTotal);
  const [likes, setLikes] = useState(likeCount);
  const [isLiked, setIsLiked] = useState(liked);
  const [saved, setSaved] = useState(bookmarked);
  const [tipOpen, setTipOpen] = useState(false);
  const [burst, setBurst] = useState(false);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const isOwner = viewerId !== null && viewerId === authorId;
  const isReader = viewerId !== null && viewerId !== authorId;

  async function share() {
    const text = `${document.title} ${location.href}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url: location.href });
        return;
      }
      await navigator.clipboard.writeText(text);
    } catch {
      // 用户取消系统分享 或 剪贴板不可用：降级提示手动复制
      prompt("复制链接分享这篇文章：", location.href);
      return;
    }
    setShared(true);
    setTimeout(() => setShared(false), 1600);
  }

  async function bookmark() {
    if (busy || viewerId === null) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/articles/${slug}/bookmark`, { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; bookmarked?: boolean; error?: string };
      if (r.ok && d.ok) {
        setSaved(Boolean(d.bookmarked));
        setMsg(d.bookmarked ? "已收入书签 · 在个人中心可回看" : "已从书签移除");
      } else {
        setErr(d.error ?? "收藏失败");
      }
    } catch {
      setErr("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  async function like() {
    if (busy || viewerId === null) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/articles/${slug}/like`, { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; liked?: boolean; likeCount?: number; error?: string };
      if (r.ok && d.ok) {
        setIsLiked(Boolean(d.liked));
        setLikes(d.likeCount ?? likes);
      } else {
        setErr(d.error ?? "点赞失败");
      }
    } catch {
      setErr("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  async function boost() {
    if (busy) return;
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await fetch(`/api/articles/${slug}/boost`, { method: "POST" });
      const d = await r.json();
      if (r.ok && d.ok) {
        setBoosted(d.boostUntil);
        setMsg(`加热成功 · 已延至 ${fmt(d.boostUntil)} · 余额 ${d.balance}`);
        router.refresh();
      } else {
        setErr(d.error ?? "加热失败");
      }
    } catch {
      setErr("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  async function tip(amount: number) {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/articles/${slug}/tip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        setTips((t) => t + amount);
        setTipOpen(false);
        setBurst(true);
        setMsg(`已打赏 ${amount} 滴墨水，作者收到 ${d.authorGot} 滴 · 余额 ${d.balance}`);
        router.refresh();
      } else {
        setErr(d.error ?? "打赏失败");
      }
    } catch {
      setErr("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="article-actions">
      {boosted && (
        <span className="boost-badge" title="加热中的文章在信息流中优先展示">
          热 · 至 {fmt(boosted)}
        </span>
      )}
      <span className="tips-total" title="本文累计收到打赏">
        墨 {tips.toLocaleString()} 点
      </span>

      {/* 点赞：登录可点，游客引导登录 */}
      {viewerId === null ? (
        <a className="act-btn like ghost" href="/login" title="登录后可以点赞">
          ♡ {likes.toLocaleString()}
        </a>
      ) : (
        <button
          className={"act-btn like" + (isLiked ? " on" : "")}
          onClick={like}
          disabled={busy || isOwner}
          title={isOwner ? "不能赞自己的文章" : isLiked ? "取消点赞" : "推荐这篇好文"}
        >
          {isLiked ? "♥" : "♡"} {likes.toLocaleString()}
        </button>
      )}

      <button className="act-btn ghost" onClick={share} title="复制链接，分享给朋友">
        {shared ? "✓ 链接已复制" : "⇗ 分享"}
      </button>

      <a className="act-btn ghost" href={`/api/articles/${slug}/export`} title="下载本文 Markdown 原稿">
        ↓ MD
      </a>

      {viewerId === null ? (
        <a className="act-btn ghost" href="/login" title="登录后可以收藏">
          ☆ 收藏
        </a>
      ) : (
        <button
          className={"act-btn ghost" + (saved ? " saved" : "")}
          onClick={bookmark}
          disabled={busy}
          title={saved ? "已收藏 · 在个人中心「书签」可回看" : "收入书签，稍后再读"}
        >
          {saved ? "★ 已收藏" : "☆ 收藏"}
        </button>
      )}

      {isOwner && (
        <button className="act-btn owner" onClick={boost} disabled={busy} title="花 80 滴墨水，文章在信息流加权 24 小时，可叠加延长">
          {boosted ? "再加热 24h · 80 滴" : "加热 24h · 80 滴"}
        </button>
      )}
      {isReader && (
        <button className="act-btn reader" onClick={() => { setTipOpen(true); setMsg(""); setErr(""); }} disabled={busy}>
          打赏墨水
        </button>
      )}

      {msg && <span className="act-msg">{msg}</span>}
      {err && <span className="act-err">{err}</span>}

      {tipOpen && (
        <div className="cashier-mask" onClick={() => setTipOpen(false)} role="presentation">
          <div className="cashier tip-cashier" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="墨水打赏">
            <span className="kicker">TIP · 墨水打赏</span>
            <b className="tip-title">请作者喝点墨水</b>
            <p className="tip-sub">打赏的 90% 直接进入作者墨仓，平台留 10% 维持墨水循环。</p>
            <div className="tip-options">
              {[10, 50].map((a) => (
                <button key={a} className="tip-option" onClick={() => tip(a)} disabled={busy}>
                  <b>{a}</b>
                  <i>滴</i>
                </button>
              ))}
            </div>
            {err && <p className="act-err">{err}</p>}
            <button className="cashier-close" onClick={() => setTipOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
      {burst && <InkBurst onDone={() => setBurst(false)} />}
    </div>
  );
}
