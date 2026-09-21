"use client";

// 付费墙解锁卡：试读结束处展示定价与解锁按钮；解锁成功刷新页面揭示全文
// v17.7：展示层重构为「解锁契约」——
//   墨纸双色 + 封缄顶带 + 骑缝虚线 + 价签列，全部复用既有 token，结构类名统一 pwq- 前缀
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Props = {
  slug: string;
  price: number;
  /** 早鸟原价（有折扣时用于划线展示） */
  originalPrice?: number;
  /** 早鸟截止时间（ISO）；到点后由服务端计价自动回落原价 */
  discountUntil?: string | null;
  loggedIn: boolean;
  balance: number | null;
  /** 累计解锁人次（>0 时显示热度） */
  unlockCount?: number;
  /** 正文字数（展示层信息，用于契约条款；缺省时不显示体量） */
  charCount?: number;
  /** 作者分身累计回答次数（展示层信息） */
  qaCount?: number;
};

/** 早鸟倒计时：按截止时间显示「还剩 X 天 / X 小时」，每分钟自刷新 */
function useCountdown(until?: string | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3.6e6);
  if (h >= 48) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h >= 1) return `${h} 小时 ${Math.floor((ms % 3.6e6) / 6e4)} 分`;
  return `${Math.max(1, Math.floor(ms / 6e4))} 分钟`;
}

export default function PaywallCard({
  slug,
  price,
  originalPrice,
  discountUntil,
  unlockCount = 0,
  loggedIn,
  balance,
  charCount,
  qaCount = 0,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  // 付费墙到达埋点：每个浏览器会话对同一篇只记一次，失败静默
  useEffect(() => {
    const key = `pwv:${slug}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* 隐私模式等场景忽略 */
    }
    fetch(`/api/articles/${slug}/paywall-view`, { method: "POST" }).catch(() => {});
  }, [slug]);

  const short = balance !== null && balance < price;
  const hasDiscount = Boolean(originalPrice && originalPrice > price);
  const countdown = useCountdown(hasDiscount ? discountUntil : null);

  async function unlock() {
    if (busy || done) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/articles/${slug}/unlock`, { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; error?: string; already?: boolean };
      if (!r.ok || !d.ok) {
        setErr(d.error ?? "解锁失败，请稍后再试");
        return;
      }
      setDone(true);
      router.refresh(); // 服务端重查 viewerUnlocked，揭示全文
    } catch {
      setErr("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  // 三个分支互斥，避免渲染出「点了一定失败」的死按钮
  const cta = !loggedIn ? (
    <Link className="pwq-cta" href="/login">
      登录后解锁
    </Link>
  ) : short ? (
    <Link className="pwq-cta" href="/points">
      墨水不足 · 去墨仓补货 →
    </Link>
  ) : (
    <button className="pwq-cta" onClick={unlock} disabled={busy || done} aria-busy={busy}>
      {done ? "已解锁 · 揭示全文…" : busy ? "解锁中…" : "解锁阅读全文"}
    </button>
  );

  return (
    <section className="paywall-card" aria-label="付费内容解锁">
      <div className="pwq-band">
        <span className="pwq-seal" aria-hidden="true">
          缄
        </span>
        <span className="pwq-band-txt">
          付费专稿 · 试读止于此
          {hasDiscount && countdown && <i className="pwq-band-flag">早鸟价</i>}
        </span>
        <span className="pwq-band-lat" aria-hidden="true">
          PAYWALL
        </span>
      </div>

      <div className="pwq-body">
        <div className="pwq-main">
          <b className="pwq-title">试读到此为止</b>
          {unlockCount > 0 && (
            <p className="pwq-heat">
              <b className="pwq-heat-n">{unlockCount.toLocaleString()}</b>
              <span>人已解锁 · 跟上同频读者</span>
            </p>
          )}
          <ul className="pwq-terms">
            <li>
              <span className="pwq-tk">全文</span>
              {charCount ? `本篇 ${charCount.toLocaleString()} 字正文与全部图示` : "本篇正文与全部图示"}
            </li>
            <li>
              <span className="pwq-tk">追问</span>
              {qaCount > 0
                ? `可向作者 AI 分身继续追问（已答 ${qaCount.toLocaleString()} 次）`
                : "可向作者 AI 分身继续追问"}
            </li>
            <li>
              <span className="pwq-tk">分成</span>
              作者得解费用的七成，直接支持持续写作
            </li>
          </ul>
        </div>

        <div className="pwq-deal">
          <div className="pwq-tag">
            <p className="pwq-tag-k">解锁价</p>
            <p className="pwq-price">
              {hasDiscount && <s className="pwq-orig">{originalPrice}</s>}
              <span className="pwq-num">{price}</span>
              <i>点墨</i>
            </p>
            {hasDiscount && <p className="pwq-save">省 {originalPrice! - price} 点墨</p>}
            {countdown && (
              <p className="pwq-countdown">
                距恢复原价 <b>{countdown}</b>
              </p>
            )}
          </div>

          {cta}

          {loggedIn && balance !== null && (
            <p className="pwq-balance">
              余额 <b>{balance.toLocaleString()}</b> 点墨
              {!short && (
                <>
                  <span className="pwq-sep" aria-hidden="true">
                    ·
                  </span>
                  作者得 {Math.floor(price * 0.7)} 点
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {err && <p className="pw-err">✕ {err}</p>}
    </section>
  );
}
