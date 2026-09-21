"use client";

// 安全中心交互层：改密 / 两步验证开关 / 设备下线（v13.5）
import { useState } from "react";

type SessionRow = {
  id: number;
  ua: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
};
type AuditRow = {
  id: number;
  event: string;
  ip: string | null;
  detail: string | null;
  created_at: string;
};

const EVENT_LABEL: Record<string, string> = {
  login_ok: "登录成功",
  login_fail: "登录失败",
  login_2fa: "两步验证",
  logout: "退出登录",
  register: "注册账号",
  password_change: "修改密码",
  password_reset: "重置密码",
  totp_enable: "开启两步验证",
  totp_disable: "关闭两步验证",
  session_revoke: "下线设备",
};

const EVENT_CLS: Record<string, string> = {
  login_ok: "ok",
  register: "ok",
  password_change: "ok",
  totp_enable: "ok",
  login_fail: "bad",
  password_reset: "warn",
  session_revoke: "warn",
};

/** UA → 人类可读设备摘要 */
function deviceLabel(ua: string | null): string {
  if (!ua) return "未知设备";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : "浏览器";
  const os =
    /Windows NT 10/.test(ua) ? "Windows" :
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad/.test(ua) ? "iOS" :
    /Linux/.test(ua) ? "Linux" : "未知系统";
  return `${os} · ${browser}`;
}

function fmtTime(s: string): string {
  try {
    return new Date(s.replace(" ", "T")).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return s;
  }
}

export default function SecurityClient({
  email,
  nickname,
  totpEnabled: initTotp,
  sessions: initSessions,
  audits,
}: {
  email: string;
  nickname: string;
  totpEnabled: boolean;
  sessions: SessionRow[];
  audits: AuditRow[];
}) {
  const [sessions, setSessions] = useState<SessionRow[]>(initSessions);
  const [totpOn, setTotpOn] = useState(initTotp);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 改密
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [busyPw, setBusyPw] = useState(false);

  // 2FA
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [offPw, setOffPw] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busyTotp, setBusyTotp] = useState(false);

  const others = sessions.filter((s) => !s.current);

  function flash(kind: "ok" | "err", text: string) {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 6000);
  }

  async function changePw() {
    if (busyPw) return;
    if (newPw.length < 8 || !/[a-zA-Z]/.test(newPw) || !/[0-9]/.test(newPw)) {
      flash("err", "新密码至少 8 位，且需同时包含字母和数字");
      return;
    }
    setBusyPw(true);
    try {
      const r = await fetch("/api/security/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string; hint?: string };
      if (d.ok) {
        flash("ok", d.hint ?? "密码已更新");
        setOldPw("");
        setNewPw("");
      } else flash("err", d.error ?? "操作失败");
    } catch {
      flash("err", "网络异常，请重试");
    } finally {
      setBusyPw(false);
    }
  }

  async function totpStart() {
    setBusyTotp(true);
    try {
      const r = await fetch("/api/security/2fa", { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; secret?: string; otpauth?: string; error?: string };
      if (d.ok && d.secret && d.otpauth) setSetup({ secret: d.secret, otpauth: d.otpauth });
      else flash("err", d.error ?? "生成失败");
    } catch {
      flash("err", "网络异常，请重试");
    } finally {
      setBusyTotp(false);
    }
  }

  async function totpConfirm() {
    if (busyTotp) return;
    setBusyTotp(true);
    try {
      const r = await fetch("/api/security/2fa", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode.trim() }),
      });
      const d = (await r.json()) as { ok?: boolean; backupCodes?: string[]; error?: string };
      if (d.ok) {
        setTotpOn(true);
        setSetup(null);
        setTotpCode("");
        setBackupCodes(d.backupCodes ?? null);
      } else flash("err", d.error ?? "验证失败");
    } catch {
      flash("err", "网络异常，请重试");
    } finally {
      setBusyTotp(false);
    }
  }

  async function totpOff() {
    if (busyTotp) return;
    setBusyTotp(true);
    try {
      const r = await fetch("/api/security/2fa", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: offPw, code: totpCode.trim() }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (d.ok) {
        setTotpOn(false);
        setOffPw("");
        setTotpCode("");
        flash("ok", "两步验证已关闭");
      } else flash("err", d.error ?? "关闭失败");
    } catch {
      flash("err", "网络异常，请重试");
    } finally {
      setBusyTotp(false);
    }
  }

  async function killSession(id: number) {
    try {
      const r = await fetch("/api/security/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (d.ok) setSessions((ss) => ss.filter((s) => s.id !== id));
      else flash("err", d.error ?? "下线失败");
    } catch {
      flash("err", "网络异常，请重试");
    }
  }

  async function killOthers() {
    try {
      const r = await fetch("/api/security/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string; hint?: string };
      if (d.ok) {
        setSessions((ss) => ss.filter((s) => s.current));
        flash("ok", d.hint ?? "已下线其他设备");
      } else flash("err", d.error ?? "操作失败");
    } catch {
      flash("err", "网络异常，请重试");
    }
  }

  return (
    <div className="sec-wrap">
      {msg && (
        <p className={`sec-flash ${msg.kind === "ok" ? "ok" : "err"}`} role="status">
          {msg.text}
        </p>
      )}

      {/* —— 概览 —— */}
      <div className="sec-grid">
        <div className="sec-stat">
          <span className="sec-stat-num">{sessions.length}</span>
          <span className="sec-stat-label">在线设备</span>
        </div>
        <div className={`sec-stat ${totpOn ? "on" : "off"}`}>
          <span className="sec-stat-num">{totpOn ? "已开启" : "未开启"}</span>
          <span className="sec-stat-label">两步验证</span>
        </div>
        <div className="sec-stat">
          <span className="sec-stat-num">{audits.filter((a) => a.event === "login_fail").length}</span>
          <span className="sec-stat-label">近期失败尝试（最近 20 条）</span>
        </div>
      </div>

      {/* —— 两步验证 —— */}
      <section className="sec-card">
        <h2 className="sec-h2">
          两步验证 <span className={`sec-badge ${totpOn ? "on" : "off"}`}>{totpOn ? "已开启" : "未开启"}</span>
        </h2>
        <p className="sec-desc">
          开启后登录需要「密码 + 验证器 6 位码」双因子，即使密码泄露账号也攻不破。兼容 Google
          Authenticator、Microsoft Authenticator、微信验证器小程序等。
        </p>
        {!totpOn && !setup && (
          <button className="sec-btn primary" onClick={totpStart} disabled={busyTotp}>
            {busyTotp ? "生成中…" : "开启两步验证"}
          </button>
        )}
        {!totpOn && setup && (
          <div className="totp-setup">
            <p className="sec-desc">第一步：在验证器 App 中添加以下密钥（手动输入或复制链接）：</p>
            <code className="totp-secret">{setup.secret}</code>
            <p className="totp-url">{setup.otpauth}</p>
            <p className="sec-desc">第二步：输入 App 显示的 6 位验证码完成绑定：</p>
            <div className="code-row">
              <input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6 位验证码"
                inputMode="numeric"
                className="code-input"
                aria-label="TOTP 验证码"
              />
              <button className="sec-btn primary" onClick={totpConfirm} disabled={busyTotp}>
                {busyTotp ? "验证中…" : "确认开启"}
              </button>
            </div>
          </div>
        )}
        {totpOn && (
          <div className="totp-setup">
            <p className="sec-desc">关闭需验证登录密码 + 当前验证码（防止设备被盗后关闭 2FA）：</p>
            <div className="code-row">
              <input
                value={offPw}
                onChange={(e) => setOffPw(e.target.value)}
                placeholder="登录密码"
                type="password"
                aria-label="登录密码"
              />
              <input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6 位验证码"
                inputMode="numeric"
                className="code-input"
                aria-label="TOTP 验证码"
              />
              <button className="sec-btn danger" onClick={totpOff} disabled={busyTotp}>
                {busyTotp ? "处理中…" : "关闭两步验证"}
              </button>
            </div>
          </div>
        )}
        {backupCodes && (
          <div className="backup-box">
            <p className="sec-desc strong">请立即抄写这 10 枚一次性备份码（仅显示这一次，丢失无法找回；每枚可替代验证码用一次）：</p>
            <div className="backup-grid">
              {backupCodes.map((c) => (
                <code key={c}>{c}</code>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* —— 修改密码 —— */}
      <section className="sec-card">
        <h2 className="sec-h2">修改密码</h2>
        <p className="sec-desc">需验证旧密码；新密码过泄露库（HIBP）检查；成功后自动下线其他所有设备。</p>
        <div className="sec-form">
          <input
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder="当前密码"
            type="password"
            aria-label="当前密码"
          />
          <input
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="新密码（8 位以上，含字母和数字）"
            type="password"
            aria-label="新密码"
            onKeyDown={(e) => e.key === "Enter" && changePw()}
          />
          <button className="sec-btn primary" onClick={changePw} disabled={busyPw}>
            {busyPw ? "提交中…" : "更新密码"}
          </button>
        </div>
      </section>

      {/* —— 设备管理 —— */}
      <section className="sec-card">
        <h2 className="sec-h2">登录设备</h2>
        <p className="sec-desc">每一台登录过且会话未过期的设备。发现陌生设备？立即下线并改密。</p>
        {others.length > 0 && (
          <button className="sec-btn danger" onClick={killOthers}>
            下线其他所有设备（{others.length}）
          </button>
        )}
        <ul className="dev-list">
          {sessions.map((s) => (
            <li key={s.id} className={s.current ? "current" : ""}>
              <span className="dev-dot" aria-hidden="true" />
              <span className="dev-main">
                <strong>
                  {deviceLabel(s.ua)}
                  {s.current && <em className="dev-now">本机</em>}
                </strong>
                <small>
                  IP {s.ip ?? "—"} · 活跃 {fmtTime(s.last_seen_at)} · 登录 {fmtTime(s.created_at)}
                </small>
              </span>
              {!s.current && (
                <button className="dev-kill" onClick={() => killSession(s.id)}>
                  下线
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* —— 登录历史 —— */}
      <section className="sec-card">
        <h2 className="sec-h2">安全事件（最近 20 条）</h2>
        <p className="sec-desc">登录、改密、两步验证、设备下线全留痕。出现不认识的失败尝试？提高警惕并开两步验证。</p>
        {audits.length === 0 ? (
          <p className="sec-empty">暂无记录 —— 下一次登录就会出现在这里。</p>
        ) : (
          <ul className="audit-list">
            {audits.map((a) => (
              <li key={a.id}>
                <span className={`audit-tag ${EVENT_CLS[a.event] ?? ""}`}>{EVENT_LABEL[a.event] ?? a.event}</span>
                <span className="audit-meta">
                  {fmtTime(a.created_at)} · IP {a.ip ?? "—"}
                  {a.detail ? ` · ${a.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="sec-footnote">
        {nickname}（{email}）· 密码 scrypt 加盐哈希存储 · 会话令牌 HMAC 签名 + 服务器端吊销 · 敏感操作全量审计
      </p>
    </div>
  );
}
