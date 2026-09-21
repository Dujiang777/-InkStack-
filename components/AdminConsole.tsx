"use client";

// 运营台完整版：总览 / 审核 / 内容 / 用户 / 举报 / 日志
// 所有敏感动作走 /api/admin/*（服务端二次鉴权）并落审计日志，操作后 router.refresh()
import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  AdminArticleRow,
  ReviewRow,
  AdminUserRow,
  ReportRow,
  AdminActionLogRow,
  AdminInsights,
  AdminOrderRow,
  AdminCommentRow,
} from "@/lib/data";
import AdminArticles from "./AdminArticles";
import AdminCharts from "./AdminCharts";
import { plainText } from "./plain-text";

type Stats = {
  users: number;
  articles: number;
  pending: number;
  comments: number;
  qa: number;
  reports: number;
  tips: number;
  topup: number;
  banned: number;
};

type Props = {
  stats: Stats;
  recentQa: { question: string; createdAt: string }[];
  articles: AdminArticleRow[];
  review: ReviewRow[];
  users: AdminUserRow[];
  reports: ReportRow[];
  logs: AdminActionLogRow[];
  insights: AdminInsights;
  orders: AdminOrderRow[];
  commentRows: AdminCommentRow[];
  viewerRole: string;
};

type Tab = "overview" | "review" | "content" | "users" | "reports" | "logs" | "comments" | "orders";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "review", label: "审核" },
  { key: "content", label: "内容" },
  { key: "users", label: "用户" },
  { key: "reports", label: "举报" },
  { key: "comments", label: "评论" },
  { key: "orders", label: "资金" },
  { key: "logs", label: "日志" },
];

const ROLE_LABEL: Record<string, string> = {
  developer: "开发者",
  admin: "管理员",
  author: "作者",
  reader: "读者",
  user: "读者",
};

export default function AdminConsole({ stats, recentQa, articles, review, users, reports, logs, insights, orders, commentRows, viewerRole }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  const openReports = reports.filter((r) => r.status === "open");
  const filteredUsers = users.filter(
    (u) =>
      !q.trim() ||
      u.nickname.toLowerCase().includes(q.trim().toLowerCase()) ||
      u.email.toLowerCase().includes(q.trim().toLowerCase())
  );

  async function post(url: string, body: unknown, key: string): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setErr(d.error ?? "操作失败");
        return false;
      }
      setMsg("已执行 ✓");
      router.refresh();
      return true;
    } catch {
      setErr("网络异常");
      return false;
    } finally {
      setBusy("");
    }
  }

  /* ---------- 审核 ---------- */
  const approve = (slug: string) => post("/api/admin/articles", { slug, action: "approve" }, "rv" + slug);
  const reject = (slug: string) => {
    const note = prompt("填写驳回原因（将通知作者，可在「我的书房」改后重提）：");
    if (!note || !note.trim()) return;
    post("/api/admin/articles", { slug, action: "reject", note: note.trim() }, "rv" + slug);
  };

  /* ---------- 用户 ---------- */
  const ban = (u: AdminUserRow) => {
    if (confirm(`确定封禁「${u.nickname}」（${u.email}）？封禁后立即掉线且无法登录。`)) {
      post("/api/admin/users", { userId: u.id, action: "ban" }, "u" + u.id);
    }
  };
  const unban = (u: AdminUserRow) => post("/api/admin/users", { userId: u.id, action: "unban" }, "u" + u.id);
  const adjust = (u: AdminUserRow, action: "grant" | "revoke") => {
    const raw = prompt(action === "grant" ? `给「${u.nickname}」发放墨水数量（滴）：` : `从「${u.nickname}」扣回墨水数量（滴）：`);
    if (!raw) return;
    const amount = Math.floor(Number(raw));
    if (!amount || amount <= 0) {
      setErr("墨水数量须为正整数");
      return;
    }
    post("/api/admin/users", { userId: u.id, action, amount }, "u" + u.id);
  };
  /* v17.1：角色管理（仅 developer 可见下拉；服务端二次校验） */
  const isDeveloper = viewerRole === "developer";
  const setRole = (u: AdminUserRow, role: string) => {
    if (role === u.role) return;
    if (!confirm(`把「${u.nickname}」的角色调整为「${ROLE_LABEL[role] ?? role}」？`)) return;
    post("/api/admin/users", { userId: u.id, action: "setRole", role }, "u" + u.id);
  };

  /* ---------- 评论管理 ---------- */
  const delComment = (c: AdminCommentRow) => {
    if (confirm(`删除「${c.author}」的这条评论？其一级回复会一并删除。`)) {
      post("/api/admin/comments", { commentId: c.id, action: "delete" }, "c" + c.id);
    }
  };

  /* ---------- 举报 ---------- */
  const handleReport = (r: ReportRow, handle: "delete_content" | "keep" | "dismiss") => {
    if (handle === "delete_content" && !confirm(`确定删除被举报的${r.targetType === "article" ? "文章" : "评论"}？前台立即不可见。`)) return;
    const note = handle === "delete_content" ? undefined : prompt("处理备注（可留空）：") || undefined;
    post("/api/admin/reports", { reportId: r.id, handle, note }, "r" + r.id);
  };

  const flash = (msg || err) && (
    <p className={err ? "mig-error" : "adm-ok"}>{err ? `✕ ${err}` : msg}</p>
  );

  return (
    <div className="adm-console">
      <div className="adm-tabs" role="tablist" aria-label="运营台分区">
        {TABS.map((t) => {
          const badge =
            t.key === "review" ? stats.pending : t.key === "reports" ? openReports.length : 0;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={"adm-tab" + (tab === t.key ? " on" : "")}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {badge > 0 && <i className="adm-badge">{badge}</i>}
            </button>
          );
        })}
      </div>
      {flash}

      {/* ---------- 总览 ---------- */}
      {tab === "overview" && (
        <>
          <div className="admin-stats">
            <div className="stat">
              <span className="stat-no">{stats.users}</span>
              <span className="stat-label">注册用户{stats.banned > 0 ? ` · ${stats.banned} 封禁中` : ""}</span>
            </div>
            <div className="stat">
              <span className="stat-no">{stats.articles}</span>
              <span className="stat-label">公开文章</span>
            </div>
            <div className="stat">
              <span className="stat-no">{stats.pending}</span>
              <span className="stat-label">待审核稿件</span>
            </div>
            <div className="stat">
              <span className="stat-no">{stats.comments.toLocaleString()}</span>
              <span className="stat-label">评论总数</span>
            </div>
            <div className="stat">
              <span className="stat-no">{stats.qa.toLocaleString()}</span>
              <span className="stat-label">分身问答</span>
            </div>
            <div className="stat">
              <span className="stat-no">{stats.tips.toLocaleString()}</span>
              <span className="stat-label">累计打赏墨水</span>
            </div>
            <div className="stat">
              <span className="stat-no">{stats.topup.toLocaleString()}</span>
              <span className="stat-label">充值到账墨水</span>
            </div>
            <div className="stat">
              <span className="stat-no">{openReports.length}</span>
              <span className="stat-label">待处理举报</span>
            </div>
          </div>
          <AdminCharts insights={insights} />
          <div className="section-head">
            <h2>最近分身问答</h2>
          </div>
          <ul className="admin-qa-list">
            {recentQa.map((item, i) => (
              <li key={i}>
                <span className="rank">{String(i + 1).padStart(2, "0")}</span>
                <span className="q">{item.question}</span>
                <span className="t">{item.createdAt}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ---------- 审核队列 ---------- */}
      {tab === "review" && (
        <div className="adm-review">
          {review.length === 0 ? (
            <p className="admin-denied">队列清空，没有待审核稿件。</p>
          ) : (
            review.map((r) => (
              <div className="review-card" key={r.slug}>
                <div className="review-info">
                  <b>{r.title}</b>
                  <span className="review-meta">
                    {r.author} · 提交于 {r.submittedAt}
                  </span>
                  {r.summary && <p className="review-sum">{plainText(r.summary)}</p>}
                </div>
                <div className="review-ops">
                  <a className="mini-btn ghost" href={`/article/${r.slug}`} target="_blank" rel="noopener">
                    预览
                  </a>
                  <button className="mini-btn ok" disabled={!!busy} onClick={() => approve(r.slug)}>
                    通过
                  </button>
                  <button className="mini-btn warn" disabled={!!busy} onClick={() => reject(r.slug)}>
                    驳回
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ---------- 内容管理 ---------- */}
      {tab === "content" && <AdminArticles rows={articles} />}

      {/* ---------- 用户管理 ---------- */}
      {tab === "users" && (
        <div className="adm-users">
          <input
            className="adm-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索昵称 / 邮箱…"
            aria-label="搜索用户"
          />
          <table className="admin-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>墨仓</th>
                <th>文章</th>
                <th>注册</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id} className={u.banned ? "row-removed" : ""}>
                  <td className="cell-title">
                    {u.nickname}
                    <br />
                    <small>{u.email}</small>
                  </td>
                  <td>
                    <span className={"status st-" + (u.banned ? "banned" : u.role)}>
                      {u.banned ? "已封禁" : ROLE_LABEL[u.role] ?? u.role}
                    </span>
                  </td>
                  <td>{u.points.toLocaleString()}</td>
                  <td>{u.articleCount}</td>
                  <td className="cell-meta">{u.createdAt}</td>
                  <td className="cell-actions">
                    {isDeveloper && !u.banned && u.role !== "developer" ? (
                      <select
                        className="adm-role-select"
                        value={u.role}
                        disabled={!!busy}
                        onChange={(e) => setRole(u, e.target.value)}
                        aria-label={`调整 ${u.nickname} 的角色`}
                      >
                        <option value="reader">读者</option>
                        <option value="author">作者</option>
                        <option value="admin">管理员</option>
                      </select>
                    ) : null}
                    {u.banned ? (
                      <button className="mini-btn" disabled={!!busy} onClick={() => unban(u)}>
                        解封
                      </button>
                    ) : (
                      u.role !== "admin" && u.role !== "developer" && (
                        <button className="mini-btn warn" disabled={!!busy} onClick={() => ban(u)}>
                          封禁
                        </button>
                      )
                    )}
                    <button className="mini-btn" disabled={!!busy} onClick={() => adjust(u, "grant")}>
                      加墨
                    </button>
                    <button className="mini-btn" disabled={!!busy} onClick={() => adjust(u, "revoke")}>
                      扣墨
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredUsers.length === 0 && <p className="admin-denied">没有匹配的用户。</p>}
        </div>
      )}

      {/* ---------- 举报处理 ---------- */}
      {tab === "reports" && (
        <div className="adm-reports">
          {reports.length === 0 ? (
            <p className="admin-denied">暂无举报，社区一片清净。</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>举报内容</th>
                  <th>类型</th>
                  <th>理由</th>
                  <th>举报人</th>
                  <th>状态</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} className={r.status !== "open" ? "row-removed" : ""}>
                    <td className="cell-title">{r.targetTitle}</td>
                    <td>{r.targetType === "article" ? "文章" : "评论"}</td>
                    <td>{r.reason}</td>
                    <td>{r.reporter}</td>
                    <td>
                      <span className={"status st-" + r.status}>
                        {r.status === "open" ? "待处理" : r.status === "resolved" ? "已处理" : "已忽略"}
                      </span>
                    </td>
                    <td className="cell-actions">
                      {r.status === "open" ? (
                        <>
                          <button className="mini-btn warn" disabled={!!busy} onClick={() => handleReport(r, "delete_content")}>
                            删内容
                          </button>
                          <button className="mini-btn" disabled={!!busy} onClick={() => handleReport(r, "keep")}>
                            保留
                          </button>
                          <button className="mini-btn ghost" disabled={!!busy} onClick={() => handleReport(r, "dismiss")}>
                            忽略
                          </button>
                        </>
                      ) : (
                        <small>{r.createdAt}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------- 评论管理（v17.1） ---------- */}
      {tab === "comments" && (
        <div className="adm-comments">
          {commentRows.length === 0 ? (
            <p className="admin-denied">暂无评论。</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>评论内容</th>
                  <th>作者</th>
                  <th>文章</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {commentRows.map((c) => (
                  <tr key={c.id}>
                    <td className="cell-title cmt-cell">{c.content}</td>
                    <td>{c.author}</td>
                    <td>
                      <a href={`/article/${c.articleSlug}`} target="_blank" rel="noopener" className="cell-link">
                        {c.articleTitle}
                      </a>
                    </td>
                    <td className="cell-meta">{c.createdAt}</td>
                    <td className="cell-actions">
                      <button className="mini-btn warn" disabled={!!busy} onClick={() => delComment(c)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------- 资金流水（v17.1）：充值 / 解锁 / 专栏打包 ---------- */}
      {tab === "orders" && (
        <div className="adm-orders">
          {orders.length === 0 ? (
            <p className="admin-denied">还没有资金流水。</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>用户</th>
                  <th>标的</th>
                  <th>花费墨水</th>
                  <th>作者分成</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={i}>
                    <td>
                      <span className={"status st-" + (o.kind === "充值" ? "paid" : "user")}>{o.kind}</span>
                    </td>
                    <td>{o.user}</td>
                    <td className="cell-title">{o.title}</td>
                    <td>{o.amount.toLocaleString()}</td>
                    <td>{o.gain > 0 ? o.gain.toLocaleString() : "—"}</td>
                    <td className="cell-meta">{o.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------- 审计日志 ---------- */}
      {tab === "logs" && (
        <ul className="adm-logs">
          {logs.length === 0 ? (
            <p className="admin-denied">还没有操作记录。</p>
          ) : (
            logs.map((g) => (
              <li key={g.id}>
                <span className="t">{g.createdAt}</span>
                <b>{g.admin}</b>
                <span className="act">{g.action}</span>
                <span className="target">
                  {g.targetType} #{g.targetId}
                </span>
                {g.detail && <span className="detail">{g.detail}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
