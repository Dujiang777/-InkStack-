"use client";

// 评论区 v2：树形回复（内联回复框 + 「回复 @xx」标注）+ 举报
// 数据形态：listComments 返回全量（含 parentId/parentAuthor），前端分组渲染
// v17.4 印章工坊：评论头像带印泥色/印式（游客与缺数据回退经典墨）
import { useEffect, useMemo, useState } from "react";
import type { CommentRow } from "@/lib/data";
import { avatarClasses } from "@/lib/avatar";

export default function CommentsSection({
  slug,
  initial,
}: {
  slug: string;
  initial: CommentRow[];
}) {
  const [comments, setComments] = useState<CommentRow[]>(initial);
  const [nickname, setNickname] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<{ id: number; nickname: string } | null>(null);
  const [reported, setReported] = useState<number[]>([]);
  const [tip, setTip] = useState("");
  const [replyTo, setReplyTo] = useState<CommentRow | null>(null);
  const [replyText, setReplyText] = useState("");
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  // 分组：顶层评论 + 每层的回复
  const tree = useMemo(() => {
    const top = comments.filter((c) => !c.parentId);
    const children = new Map<number, CommentRow[]>();
    for (const c of comments) {
      if (c.parentId) {
        const arr = children.get(c.parentId) ?? [];
        arr.push(c);
        children.set(c.parentId, arr);
      }
    }
    return { top, children };
  }, [comments]);

  async function reportComment(id: number) {
    if (!me) return;
    const reason = window.prompt("请填写举报原因（运营将人工核查）", "");
    if (!reason || reason.trim().length < 2) return;
    try {
      const res = await fetch(`/api/comments/${id}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const d = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (res.ok && d.ok) {
        setReported((r) => [...r, id]);
        flash(d.message ?? "举报已提交");
      } else {
        flash(d.error ?? "举报失败");
      }
    } catch {
      flash("网络异常，举报失败");
    }
  }

  async function likeComment(id: number) {
    if (!me) {
      flash("登录后才能点赞评论");
      return;
    }
    // 乐观更新，失败回滚
    const before = comments.find((c) => c.id === id);
    if (!before) return;
    const nextLiked = !before.viewerLiked;
    setComments((cs) =>
      cs.map((c) => (c.id === id ? { ...c, viewerLiked: nextLiked, likes: Math.max(0, c.likes + (nextLiked ? 1 : -1)) } : c))
    );
    try {
      const res = await fetch(`/api/comments/${id}/like`, { method: "POST" });
      const d = (await res.json()) as { ok?: boolean; liked?: boolean; likes?: number; error?: string };
      if (res.ok && d.ok && typeof d.likes === "number") {
        setComments((cs) => cs.map((c) => (c.id === id ? { ...c, viewerLiked: Boolean(d.liked), likes: d.likes as number } : c)));
      } else {
        setComments((cs) => cs.map((c) => (c.id === id ? before : c)));
        flash(d.error ?? "点赞失败");
      }
    } catch {
      setComments((cs) => cs.map((c) => (c.id === id ? before : c)));
      flash("网络异常，点赞失败");
    }
  }

  function flash(msg: string) {
    setTip(msg);
    setTimeout(() => setTip(""), 2500);
  }

  // 兜底刷新：拉服务端评论列表（GET 已带 viewer，viewerLiked 也正确）
  function refresh() {
    fetch(`/api/articles/${slug}/comments`)
      .then((r) => r.json())
      .then((d: { comments?: CommentRow[] }) => {
        if (Array.isArray(d.comments) && d.comments.length > 0) setComments(d.comments);
      })
      .catch(() => {});
  }

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setMe(d.user ?? null))
      .catch(() => {});
  }, []);

  function optimistic(c: Omit<CommentRow, "id" | "likes" | "viewerLiked">): CommentRow {
    return { ...c, likes: 0, viewerLiked: false, id: Date.now() + Math.floor(Math.random() * 999) };
  }

  async function submit() {
    if (busy) return;
    setError("");
    if (!content.trim()) {
      setError("写点什么再发吧");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/articles/${slug}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, content }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; comment?: CommentRow };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "发表失败，请重试");
        return;
      }
      const now = new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-");
      if (data.comment) {
        // 服务端返回真实评论行（含真实 id）——点赞/回复立即可用
        setComments((cs) => [...cs, data.comment as CommentRow]);
      } else {
        // 兜底：占位行 + 拉取服务端列表校正 id
        setComments((cs) => [
          ...cs,
          optimistic({
            nickname: me?.nickname ?? (nickname.trim().slice(0, 20) || "访客"),
            content: content.trim(),
            createdAt: now,
            parentId: null,
            parentAuthor: null,
          }),
        ]);
        refresh();
      }
      setContent("");
    } finally {
      setBusy(false);
    }
  }

  async function submitReply() {
    if (busy || !replyTo) return;
    if (!replyText.trim()) {
      flash("回复内容不能为空");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/articles/${slug}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "", content: replyText, parentId: replyTo.parentId ?? replyTo.id }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; comment?: CommentRow };
      if (!res.ok || !data.ok) {
        flash(data.error ?? "回复失败，请重试");
        return;
      }
      const now = new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-");
      if (data.comment) {
        setComments((cs) => [...cs, data.comment as CommentRow]);
      } else {
        setComments((cs) => [
          ...cs,
          optimistic({
            nickname: me?.nickname ?? "访客",
            content: replyText.trim(),
            createdAt: now,
            parentId: replyTo.parentId ?? replyTo.id,
            parentAuthor: replyTo.nickname,
          }),
        ]);
        refresh();
      }
      setReplyText("");
      setReplyTo(null);
      flash("回复已发出");
    } finally {
      setBusy(false);
    }
  }

  const total = comments.length;

  function renderItem(c: CommentRow, isReply: boolean, floor?: number) {
    return (
      <li key={c.id} className={isReply ? "comment-item reply" : "comment-item"}>
        <div className={"avatar " + avatarClasses(c.avatarTone, c.avatarShape, c.userId)} aria-hidden="true">
          {c.avatarText || c.nickname.slice(0, 1)}
        </div>
        <div className="comment-body">
          {typeof floor === "number" && <span className="comment-floor" aria-hidden="true">第 {floor} 层</span>}
          <div className="comment-meta">
            <b>{c.nickname}</b>
            {isReply && c.parentAuthor && <span className="reply-tag">回复 @{c.parentAuthor}</span>}
            <span>{c.createdAt}</span>
            <button
              className={"comment-report like" + (c.viewerLiked ? " on" : "")}
              onClick={() => likeComment(c.id)}
              title={me ? (c.viewerLiked ? "取消点赞" : "赞这条评论") : "登录后才能点赞"}
            >
              {c.viewerLiked ? "♥" : "♡"} {c.likes}
            </button>
            {me && !reported.includes(c.id) && (
              <button className="comment-report" onClick={() => reportComment(c.id)} title="举报该评论">
                举报
              </button>
            )}
            {reported.includes(c.id) && <span className="comment-reported">已举报</span>}
            <button
              className="comment-report go"
              onClick={() => {
                setReplyTo(replyTo?.id === c.id ? null : c);
                setReplyText("");
              }}
              title="回复这条评论"
            >
              {replyTo?.id === c.id ? "收起" : "回复"}
            </button>
          </div>
          <p>{c.content}</p>
          {replyTo?.id === c.id && (
            <div className="reply-box">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={me ? `回复 @${c.nickname}…` : `回复 @${c.nickname}（登录后回复可获墨水奖励）…`}
                rows={2}
                maxLength={1000}
                aria-label="回复内容"
              />
              <div className="reply-actions">
                <button className="mini" onClick={() => setReplyTo(null)}>
                  取消
                </button>
                <button onClick={submitReply} disabled={busy}>
                  {busy ? "发送中…" : "发送回复"}
                </button>
              </div>
            </div>
          )}
        </div>
      </li>
    );
  }

  return (
    <section className="comments" aria-label="评论区">
      <div className="section-head comments-head">
        <span className="comments-seal" aria-hidden="true">
          墨谈
        </span>
        <h2>评论 · {total}</h2>
        <span className="comments-note">
          {tip || (me ? `已绑定账号「${me.nickname}」· 评论将署你的昵称` : "游客昵称版 · 登录后自动绑定账号")}
        </span>
      </div>
      <ul className="comment-list">
        {total === 0 && <li className="comment-empty">还没有评论，坐个沙发？</li>}
        {tree.top.map((c, i) => {
          const replies = tree.children.get(c.id) ?? [];
          const isCollapsed = collapsed[c.id];
          return (
            <li key={c.id} className="comment-thread">
              <ul className="thread-root">{renderItem(c, false, i + 1)}</ul>
              {replies.length > 0 && (
                <>
                  <button
                    className="thread-toggle"
                    onClick={() => setCollapsed((m) => ({ ...m, [c.id]: !m[c.id] }))}
                  >
                    {isCollapsed ? `▾ 展开 ${replies.length} 条回复` : `▸ 收起 ${replies.length} 条回复`}
                  </button>
                  {!isCollapsed && <ul className="thread-replies">{replies.map((r) => renderItem(r, true))}</ul>}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div className="comment-form">
        {!me && (
          <input
            className="comment-nickname"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="昵称（留空则显示「访客」，最长 20 字）"
            aria-label="评论昵称"
            maxLength={20}
          />
        )}
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="说点什么…（最长 1000 字）"
          aria-label="评论内容"
          rows={3}
          maxLength={1000}
        />
        {error && <p className="comment-error" role="alert">{error}</p>}
        <div className="comment-actions">
          <span className="comment-counter">{content.length} / 1000</span>
          <button onClick={submit} disabled={busy}>
            {busy ? "发表中…" : "落笔成评"}
          </button>
        </div>
      </div>
    </section>
  );
}
