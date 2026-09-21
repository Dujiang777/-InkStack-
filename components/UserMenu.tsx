"use client";

// 导航右侧用户菜单：昵称 + 墨水 + 每日签到（连签档位 + 飘字反馈）+ 登出；未登录显示登录入口
import { useEffect, useRef, useState } from "react";

type Me = { id: number; nickname: string; points: number; role: string } | null;
type Checkin = { checkedInToday: boolean; streak: number; reward: number; next: { days: number; reward: number } | null };

export default function UserMenu() {
  const [me, setMe] = useState<Me>(null);
  const [loaded, setLoaded] = useState(false);
  const [ci, setCi] = useState<Checkin | null>(null);
  const [signing, setSigning] = useState(false);
  const [pop, setPop] = useState<string | null>(null);
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { user: Me }) => {
        setMe(d.user);
        if (d.user) {
          fetch("/api/checkin")
            .then((r) => (r.ok ? r.json() : null))
            .then((d: Checkin | null) => {
              if (d) setCi(d);
            })
            .catch(() => {});
        }
      })
      .catch(() => setMe(null))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => () => {
    if (popTimer.current) clearTimeout(popTimer.current);
  }, []);

  async function checkin() {
    if (!me || signing) return;
    setSigning(true);
    try {
      const r = await fetch("/api/checkin", { method: "POST" });
      const d = await r.json();
      if (r.ok) {
        setCi({
          checkedInToday: true,
          streak: d.streak ?? 1,
          reward: d.reward ?? 20,
          next: d.next ?? null,
        });
        if (typeof d.balance === "number") setMe({ ...me, points: d.balance });
        // 飘字反馈：+N 墨点
        setPop(`+${d.reward ?? 20}`);
        if (popTimer.current) clearTimeout(popTimer.current);
        popTimer.current = setTimeout(() => setPop(null), 1400);
      }
    } catch {
      /* 网络异常：下次点击重试 */
    } finally {
      setSigning(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/";
  }

  if (!loaded) return <span className="user-menu loading">…</span>;

  if (!me) {
    return (
      <LinkLike href="/login">
        <span className="no">陆</span>登录 / 注册
      </LinkLike>
    );
  }

  const next = ci?.next ?? null;
  const title = ci?.checkedInToday
    ? next
      ? `已连续签到 ${ci.streak} 天 · 再签 ${next.days} 天升至 +${next.reward}`
      : `已连续签到 ${ci.streak} 天 · 已至周期收官 +40`
    : next
      ? `今日签到 +${ci?.reward ?? 10} · 连签 ${next.days} 天后升至 +${next.reward}`
      : `今日签到 +${ci?.reward ?? 10}`;

  return (
    <span className="user-menu">
      <a href="/me" className="me-link" title="进入个人中心">
        {me.nickname}
      </a>
      <a className="points-chip" href="/points" title="进入墨仓 · 墨水账户">
        墨水 {me.points}
      </a>
      <span className="checkin-wrap">
        {pop && <span className="checkin-pop">{pop}</span>}
        <button
          className={`checkin-btn${ci?.checkedInToday ? " done" : ""}`}
          onClick={checkin}
          disabled={signing || ci?.checkedInToday}
          title={title}
        >
          {ci?.checkedInToday ? `已签 · 连${ci.streak}天` : `签到 +${ci?.reward ?? 10}`}
        </button>
      </span>
      <a className="sec-shield" href="/security" title="安全中心：设备管理 · 两步验证 · 登录历史">
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8Z" />
        </svg>
        安全
      </a>
      <button onClick={logout}>登出</button>
    </span>
  );
}

function LinkLike({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="tab" id="nav-login">
      {children}
    </a>
  );
}
