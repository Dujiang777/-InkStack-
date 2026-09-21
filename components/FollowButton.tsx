"use client";

// 关注按钮：toggle + 计数即时更新；作者本人不渲染（由父组件控制）
import { useState } from "react";

export default function FollowButton({
  authorId,
  initialFollowing,
  initialFollowers,
}: {
  authorId: number;
  initialFollowing: boolean;
  initialFollowers: number;
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [followers, setFollowers] = useState(initialFollowers);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [needLogin, setNeedLogin] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/users/${authorId}/follow`, { method: "POST" });
      const d = (await r.json()) as {
        ok?: boolean;
        following?: boolean;
        followers?: number;
        error?: string;
      };
      if (r.status === 401) {
        setNeedLogin(true);
        return;
      }
      if (r.ok && d.ok) {
        setFollowing(Boolean(d.following));
        setFollowers(d.followers ?? followers);
      } else {
        setErr(d.error ?? "操作失败");
        setTimeout(() => setErr(""), 2000);
      }
    } catch {
      setErr("网络异常");
      setTimeout(() => setErr(""), 2000);
    } finally {
      setBusy(false);
    }
  }

  if (needLogin) {
    return (
      <a className="follow-btn" href="/login" title="登录后关注作者">
        登录后关注
      </a>
    );
  }

  return (
    <span className="follow-wrap">
      <button
        className={"follow-btn" + (following ? " on" : "")}
        onClick={toggle}
        disabled={busy}
        title={following ? "点击取消关注" : "把 TA 加入你的关注，新文章不再错过"}
      >
        {following ? "已关注 ✓" : "+ 关注"}
      </button>
      <small className="follow-count">{followers.toLocaleString()} 位读者</small>
      {err && <em className="follow-err">{err}</em>}
    </span>
  );
}
