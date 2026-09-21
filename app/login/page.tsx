"use client";

// 登录 / 注册 / 忘记密码 三态页：注册走邮箱验证码流（发码 60s 倒计时）+ 密码强度条
// GitHub OAuth：凭证未配置时点击给提示，配置后即走真实流程
import { useState, useEffect, useMemo, useRef } from "react";

const OAUTH_ERRS: Record<string, string> = {
  disabled: "GitHub 登录暂未启用，请使用邮箱登录",
  state: "登录状态校验失败，请重试",
  token: "GitHub 授权失败，请重试",
  profile: "未能读取 GitHub 资料或主邮箱，请检查授权范围",
  db: "数据库暂不可用，请稍后再试",
  network: "网络异常，请稍后再试",
};

type Tab = "login" | "register" | "reset";

function strengthOf(pw: string): 0 | 1 | 2 | 3 {
  if (pw.length < 8) return 0;
  let score = 1;
  if (/[a-zA-Z]/.test(pw) && /[0-9]/.test(pw)) score = 2;
  if (score === 2 && (pw.length >= 12 || /[^a-zA-Z0-9]/.test(pw))) score = 3;
  return score as 1 | 2 | 3;
}
const STRENGTH_LABEL = ["", "弱", "中", "强"];
const STRENGTH_CLS = ["", "pw-s1", "pw-s2", "pw-s3"];

export default function LoginPage() {
  const [tab, setTab] = useState<Tab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(""); // 发码成功/重置成功等绿色提示
  const [busy, setBusy] = useState(false);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghHint, setGhHint] = useState("");
  const [qqEnabled, setQqEnabled] = useState(false); // QQ 凭证配置后按钮才出现
  const [cool, setCool] = useState(0); // 发码倒计时
  const [need2fa, setNeed2fa] = useState(false); // 登录第二段：两步验证码
  const [totp, setTotp] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);

  // 鼠标视差：把归一化坐标写进 CSS 变量（--mx/--my），驱动壳体 3D 倾斜与水印/墨雾反向漂移
  useEffect(() => {
    const el = pageRef.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const my = ((e.clientY - r.top) / r.height) * 2 - 1;
      el.style.setProperty("--mx", mx.toFixed(3));
      el.style.setProperty("--my", my.toFixed(3));
    };
    const leave = () => {
      el.style.setProperty("--mx", "0");
      el.style.setProperty("--my", "0");
    };
    el.addEventListener("mousemove", move);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mousemove", move);
      el.removeEventListener("mouseleave", leave);
    };
  }, []);

  // Canvas 墨晕引擎：环境自生墨晕 + 鼠标划过即兴晕染（品牌面板内）
  const inkRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = inkRef.current;
    if (!cv || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let alive = true;
    type Bloom = { x: number; y: number; r: number; vr: number; a: number; hue: number };
    const blooms: Bloom[] = [];
    const resize = () => {
      const rect = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = rect.width * dpr;
      cv.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const spawn = (x: number, y: number, big: boolean) => {
      if (blooms.length > 40) return;
      blooms.push({ x, y, r: big ? 6 : 2.5, vr: big ? 0.5 : 0.28, a: big ? 0.42 : 0.3, hue: Math.random() * 16 });
    };
    const ambient = setInterval(() => {
      const rect = cv.getBoundingClientRect();
      spawn(Math.random() * rect.width, Math.random() * rect.height, Math.random() < 0.35);
    }, 1400);
    const mm = (e: MouseEvent) => {
      const rect = cv.getBoundingClientRect();
      spawn(e.clientX - rect.left, e.clientY - rect.top, false);
    };
    cv.parentElement?.addEventListener("mousemove", mm);
    const tick = () => {
      if (!alive) return;
      const rect = cv.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      for (let i = blooms.length - 1; i >= 0; i--) {
        const b = blooms[i];
        b.r += b.vr;
        b.a *= 0.986;
        if (b.a < 0.012 || b.r > 140) {
          blooms.splice(i, 1);
          continue;
        }
        const g = ctx.createRadialGradient(b.x, b.y, b.r * 0.18, b.x, b.y, b.r);
        g.addColorStop(0, `hsla(${8 + b.hue}, 62%, 46%, ${b.a})`);
        g.addColorStop(1, "hsla(10, 60%, 40%, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearInterval(ambient);
      window.removeEventListener("resize", resize);
      cv.parentElement?.removeEventListener("mousemove", mm);
    };
  }, []);

  // v14.0 全页流体墨场：整页可划墨，destination-out 拖尾让墨迹留痕渐散、缓慢漂升
  const fluidRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = fluidRef.current;
    if (!cv || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let alive = true;
    type Drop = { x: number; y: number; r: number; vr: number; a: number; hue: number; vx: number; vy: number };
    const drops: Drop[] = [];
    const resize = () => {
      const rect = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = rect.width * dpr;
      cv.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const spawn = (x: number, y: number, big: boolean) => {
      if (drops.length > 70) return;
      const gold = Math.random() < 0.22;
      drops.push({
        x, y,
        r: big ? 10 : 3.5,
        vr: big ? 0.9 : 0.55,
        a: big ? 0.34 : 0.26,
        hue: gold ? 38 + Math.random() * 8 : 6 + Math.random() * 14,
        vx: (Math.random() - 0.5) * 0.35,
        vy: -0.12 - Math.random() * 0.3,
      });
    };
    const ambient = setInterval(() => {
      const rect = cv.getBoundingClientRect();
      spawn(Math.random() * rect.width, rect.height * (0.25 + Math.random() * 0.7), Math.random() < 0.4);
    }, 950);
    const mm = (e: MouseEvent) => {
      const rect = cv.getBoundingClientRect();
      spawn(e.clientX - rect.left, e.clientY - rect.top, false);
      if (Math.random() < 0.3) {
        spawn(e.clientX - rect.left + (Math.random() - 0.5) * 44, e.clientY - rect.top + (Math.random() - 0.5) * 44, false);
      }
    };
    const host = cv.parentElement;
    host?.addEventListener("mousemove", mm);
    const tick = () => {
      if (!alive) return;
      const rect = cv.getBoundingClientRect();
      // 拖尾淡出：不清屏，用 destination-out 轻擦，墨痕渐散
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.035)";
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.globalCompositeOperation = "source-over";
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.x += d.vx;
        d.y += d.vy;
        d.r += d.vr;
        d.a *= 0.988;
        if (d.a < 0.01 || d.r > 200) {
          drops.splice(i, 1);
          continue;
        }
        const g = ctx.createRadialGradient(d.x, d.y, d.r * 0.15, d.x, d.y, d.r);
        g.addColorStop(0, `hsla(${d.hue}, 64%, 48%, ${d.a})`);
        g.addColorStop(1, `hsla(${d.hue}, 62%, 42%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearInterval(ambient);
      window.removeEventListener("resize", resize);
      host?.removeEventListener("mousemove", mm);
    };
  }, []);

  // 结语打字机（弱动效偏好直接显示全文）
  const FOOT_LINE = "写下去，墨水会记得。";
  const [footText, setFootText] = useState("");
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFootText(FOOT_LINE);
      return;
    }
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setFootText(FOOT_LINE.slice(0, i));
      if (i >= FOOT_LINE.length) clearInterval(t);
    }, 140);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (cool <= 0) return;
    const t = setTimeout(() => setCool((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cool]);

  // 回调失败时带 ?oauth=github&err=xx 回来；?tab=register 直达注册 Tab
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("tab") === "register") setTab("register");
    if (p.get("oauth")) {
      const reason = p.get("err") ?? "";
      const name = p.get("oauth");
      const provider = name === "gitee" ? "Gitee" : name === "qq" ? "QQ" : "GitHub";
      setGhHint(OAUTH_ERRS[reason] ?? `${provider} 登录未完成，请重试或使用邮箱登录`);
    }
    // 挂载时探测 QQ 凭证：配置了才渲染 QQ 按钮
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { qq?: boolean }) => setQqEnabled(Boolean(d.qq)))
      .catch(() => {});
  }, []);

  const isReg = tab === "register";
  const isReset = tab === "reset";
  const strength = useMemo(() => strengthOf(password), [password]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setError("");
    setNotice("");
    setPassword("");
    setConfirm("");
    setCode("");
    setNeed2fa(false);
    setTotp("");
  };

  async function github() {
    if (ghBusy) return;
    setGhBusy(true);
    setGhHint("");
    try {
      const r = await fetch("/api/auth/providers");
      const d = (await r.json()) as { github?: boolean; gitee?: boolean };
      if (d.github) {
        location.href = "/api/auth/github";
        return;
      }
      setGhHint("GitHub 登录凭证尚未配置（需在 .env 填入 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）。Gitee 登录已支持，国内访问更快。");
    } catch {
      setGhHint("网络异常，请稍后再试");
    } finally {
      setGhBusy(false);
    }
  }

  async function gitee() {
    if (ghBusy) return;
    setGhBusy(true);
    setGhHint("");
    try {
      const r = await fetch("/api/auth/providers");
      const d = (await r.json()) as { github?: boolean; gitee?: boolean };
      if (d.gitee) {
        location.href = "/api/auth/gitee";
        return;
      }
      setGhHint("Gitee 登录凭证尚未配置：打开 gitee.com → 设置 → 安全设置 → 第三方应用授权 → 创建应用（回调地址填 http://localhost:3100/api/auth/gitee/callback），把 Client ID / Client Secret 填入 .env 的 GITEE_CLIENT_ID / GITEE_CLIENT_SECRET 即可。");
    } catch {
      setGhHint("网络异常，请稍后再试");
    } finally {
      setGhBusy(false);
    }
  }

  async function qq() {
    if (ghBusy) return;
    setGhBusy(true);
    setGhHint("");
    try {
      location.href = "/api/auth/qq";
    } finally {
      setGhBusy(false);
    }
  }

  async function sendTwoFa() {
    // 验证器/备份码都不可用时的邮箱兜底：发 6 位临时码，填进同一验证码框即可登录
    if (cool > 0 || busy) return;
    setError("");
    setNotice("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("请先在邮箱框填写正确的账号邮箱");
      return;
    }
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), purpose: "twofa" }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; devCode?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "发送失败，请稍后再试");
        return;
      }
      setCool(60);
      if (data.devCode) {
        setTotp(data.devCode);
        setNotice(`临时验证码已生成：${data.devCode}（SMTP 未配置，本地测试直显）`);
      } else {
        setNotice("临时验证码已发送到邮箱，10 分钟内有效，直接填入验证码框即可登录");
      }
    } catch {
      setError("网络异常，请重试");
    }
  }

  async function sendCode() {
    if (cool > 0 || busy) return;
    setError("");
    setNotice("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("请先填写正确的邮箱，再获取验证码");
      return;
    }
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), purpose: isReset ? "reset" : "register" }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; devCode?: string; devHint?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "验证码发送失败，请稍后再试");
        return;
      }
      setCool(60);
      setNotice(
        data.devCode ? `验证码已生成：${data.devCode}（SMTP 未配置，本地测试直显）` : "验证码已发送到邮箱，10 分钟内有效"
      );
      if (data.devCode) setCode(data.devCode); // 本地测试自动填入
    } catch {
      setError("网络异常，请重试");
    }
  }

  async function submit() {
    if (busy) return;
    setError("");
    setNotice("");
    if (isReg) {
      if (password !== confirm) {
        setError("两次输入的密码不一致");
        return;
      }
      if (strength < 2) {
        setError("密码太弱：至少 8 位，且需同时包含字母和数字");
        return;
      }
      if (!/^\d{6}$/.test(code.trim())) {
        setError("请输入 6 位邮箱验证码");
        return;
      }
    }
    if (isReset) {
      if (password !== confirm) {
        setError("两次输入的密码不一致");
        return;
      }
      if (strength < 2) {
        setError("新密码太弱：至少 8 位，且需同时包含字母和数字");
        return;
      }
      if (!/^\d{6}$/.test(code.trim())) {
        setError("请输入 6 位邮箱验证码");
        return;
      }
    }
    setBusy(true);
    try {
      const url = isReset ? "/api/auth/reset" : `/api/auth/${tab}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isReset
            ? { email: email.trim(), password, code: code.trim() }
            : isReg
              ? { email: email.trim(), password, nickname, code: code.trim() }
              : { email: email.trim(), password, totp: totp.trim() }
        ),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; hint?: string; need2fa?: boolean };
      if (data.need2fa) {
        // 密码正确，等待两步验证码
        setNeed2fa(true);
        setNotice("密码正确：请输入验证器 App 的 6 位两步验证码（或备份码）");
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.error ?? "操作失败，请重试");
        return;
      }
      if (isReset) {
        switchTab("login");
        setNotice(data.hint ?? "密码已重置，请用新密码登录");
        return;
      }
      location.href = "/";
    } catch {
      setError("网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  const title = isReset ? "重置密码" : isReg ? "开一个新账号" : "回到你的墨栈";

  return (
    <div className="login-page" ref={pageRef}>
      <canvas className="lp-fluid" ref={fluidRef} aria-hidden="true" />
      <div className="login-wm" aria-hidden="true">墨</div>
      <div className="login-shell">
        {/* —— 左侧墨色品牌面板（纯装饰） —— */}
        <aside className="login-brand" aria-hidden="true">
          <span className="lb-poem">落笔生墨 · 字字千秋</span>
          <canvas className="lb-ink" ref={inkRef} aria-hidden="true" />
          <div className="lb-blob lb-b1" />
          <div className="lb-blob lb-b2" />
          <div className="lb-drip" />
          <div className="lb-ring" />
          <div className="lb-wave" />
          <div className="lb-dots" aria-hidden="true">
            <i /><i /><i /><i /><i /><i /><i /><i />
          </div>
          <svg className="lb-brush" viewBox="0 0 640 90" aria-hidden="true" fill="none">
            <defs>
              <linearGradient id="brushInk" x1="0" y1="0" x2="640" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#a52a22" stopOpacity="0.1" />
                <stop offset="0.45" stopColor="#d8563f" stopOpacity="0.85" />
                <stop offset="1" stopColor="#a52a22" stopOpacity="0.15" />
              </linearGradient>
            </defs>
            <path
              d="M14 62 Q 160 8 330 50 T 626 42"
              stroke="url(#brushInk)"
              strokeWidth="13"
              strokeLinecap="round"
            />
          </svg>
          <span className="lb-seal">墨</span>
          <h2 className="lb-title">
            <span>墨</span>
            <span>栈</span>
          </h2>
          <p className="lb-tag">AI 原生博客 · 墨水经济试验场</p>
          <ul className="lb-list">
            <li>
              <i>壹</i>AI 分身三通道，替你续写与问答
            </li>
            <li>
              <i>贰</i>墨水打赏 · 付费解锁 · 专栏打包
            </li>
            <li>
              <i>叁</i>每周墨报与合集书架，墨迹不散场
            </li>
          </ul>
          <p className="lb-foot">
            {footText}
            <span className="lb-caret" aria-hidden="true" />
          </p>
        </aside>
        <div className="login-card">
          <div className="login-spot" aria-hidden="true" />
        <p className="kicker">会员登录 · InkStack</p>
        <h1 className="login-title">{title}</h1>
        {!isReset && (
          <div className="login-tabs" role="tablist" aria-label="登录或注册">
            <button role="tab" aria-selected={!isReg} onClick={() => switchTab("login")}>
              登录
            </button>
            <button role="tab" aria-selected={isReg} onClick={() => switchTab("register")}>
              注册
            </button>
          </div>
        )}
        <div className="login-form">
          {/* —— 邮箱（三态共用；重置态附「返回登录」） —— */}
          <div className="code-row">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={isReset ? "注册时使用的邮箱" : isReg ? "邮箱（用于接收验证码）" : "邮箱"}
              aria-label="邮箱"
              type="email"
            />
            {(isReg || isReset) && (
              <button className="code-send" onClick={sendCode} disabled={cool > 0 || busy} type="button">
                {cool > 0 ? `${cool}s 后重发` : "获取验证码"}
              </button>
            )}
          </div>
          {(isReg || isReset) && (
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6 位邮箱验证码"
              aria-label="邮箱验证码"
              inputMode="numeric"
              className="code-input"
            />
          )}
          {/* —— 密码：登录态直接输；注册/重置态带强度条与确认 —— */}
          {tab === "login" && (
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="密码"
              aria-label="密码"
              type="password"
            />
          )}
          {(isReg || isReset) && (
            <>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isReset ? "新密码（8 位以上，含字母和数字）" : "密码（8 位以上，含字母和数字）"}
                aria-label={isReset ? "新密码" : "密码"}
                type="password"
              />
              <div className={`pw-meter ${STRENGTH_CLS[strength]}`} aria-hidden="true">
                <i /><i /><i />
                <span>{password ? STRENGTH_LABEL[strength] : ""}</span>
              </div>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="再输入一遍密码"
                aria-label="确认密码"
                type="password"
              />
            </>
          )}
          {isReg && (
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="昵称（最长 20 字）"
              aria-label="昵称"
              maxLength={20}
            />
          )}
          {/* —— 两步验证第二段：密码正确后出现 —— */}
          {tab === "login" && need2fa && (
            <>
              <input
                value={totp}
                onChange={(e) => setTotp(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12))}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="6 位两步验证码（或备份码）"
                aria-label="两步验证码"
                inputMode="numeric"
                className="code-input totp-input"
                autoFocus
              />
              <p className="login-forgot">
                验证器或备份码都不可用？{" "}
                <a
                  href="#twofa"
                  onClick={(e) => {
                    e.preventDefault();
                    sendTwoFa();
                  }}
                >
                  {cool > 0 ? `用邮箱接收临时验证码（${cool}s 后可重发）` : "用邮箱接收临时验证码"}
                </a>
              </p>
            </>
          )}
          {error && (
            <p className="comment-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="login-notice" role="status">
              {notice}
            </p>
          )}
          <button
            className="login-submit"
            onClick={submit}
            disabled={busy}
            onMouseMove={(e) => {
              const el = e.currentTarget;
              const r = el.getBoundingClientRect();
              const dx = (e.clientX - r.left - r.width / 2) / r.width;
              const dy = (e.clientY - r.top - r.height / 2) / r.height;
              el.style.translate = `${(dx * 8).toFixed(1)}px ${(dy * 5).toFixed(1)}px`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.translate = "0px 0px";
            }}
          >
            {busy ? "处理中…" : isReset ? "重置密码" : isReg ? "注册并登录" : "登录"}
          </button>
          {tab === "login" ? (
            <p className="login-forgot">
              <a href="#forgot" onClick={(e) => { e.preventDefault(); switchTab("reset"); }}>
                忘记密码？邮箱找回
              </a>
            </p>
          ) : (
            <p className="login-forgot">
              <a href="#back" onClick={(e) => { e.preventDefault(); switchTab(isReset ? "login" : "login"); }}>
                {isReset ? "← 返回登录" : "已有账号？去登录"}
              </a>
            </p>
          )}
          {!isReset && (
            <>
              <div className="oauth-divider" aria-hidden="true">
                <i />
                <span>或</span>
                <i />
              </div>
              <button className="login-gh" onClick={gitee} disabled={ghBusy} type="button">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path d="M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296Z" />
                </svg>
                {ghBusy ? "正在前往 Gitee…" : "使用 Gitee 登录"}
              </button>
              {qqEnabled && (
                <button className="login-gh" onClick={qq} disabled={ghBusy} type="button">
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                    <path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673" />
                  </svg>
                  {ghBusy ? "正在前往 QQ…" : "使用 QQ 登录"}
                </button>
              )}
              <button className="login-gh" onClick={github} disabled={ghBusy} type="button">
                <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                {ghBusy ? "正在前往 GitHub…" : "使用 GitHub 登录"}
              </button>
              {ghHint && (
                <p className="gh-hint" role="status">
                  {ghHint}
                </p>
              )}
            </>
          )}
          <p className="login-note">
            注册即送 100 滴墨水（AI 续写 15 滴/次 · 分身问答 5 滴/次）。
          </p>
        </div>
      </div>
      </div>
    </div>
  );
}
