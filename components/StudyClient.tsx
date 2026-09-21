"use client";

// 我的书房 v2：文章管理（全部/已发布/待审核/未通过/草稿箱）
// 草稿箱：编辑回创作台 / 一键发布（进审核流 + 发文奖励）/ 硬删除
// 数据列：阅读条形图（相对最大值）+ 赞/评/问答/打赏/加热中标记
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { MyArticleRow } from "@/lib/data";

type Tab = "all" | "published" | "pending" | "rejected" | "draft";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "published", label: "已发布" },
  { key: "pending", label: "待审核" },
  { key: "rejected", label: "未通过" },
  { key: "draft", label: "草稿箱" },
];

function statusOf(a: MyArticleRow): { label: string; cls: string } {
  if (a.status === "draft") return { label: "草稿", cls: "st-draft" };
  if (a.status === "removed") return { label: "已下架", cls: "st-removed" };
  if (a.reviewStatus === "pending") return { label: "待审核", cls: "st-pending" };
  if (a.reviewStatus === "rejected") return { label: "未通过", cls: "st-rejected" };
  return { label: "已发布", cls: "st-published" };
}

export default function StudyClient({ rows }: { rows: MyArticleRow[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("all");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const maxReads = useMemo(() => Math.max(1, ...rows.map((a) => a.readCount)), [rows]);

  const shown = rows.filter((a) => {
    if (tab === "all") return true;
    if (tab === "draft") return a.status === "draft";
    if (tab === "published") return a.status === "published" && a.reviewStatus === "approved";
    if (tab === "pending") return a.status === "published" && a.reviewStatus === "pending";
    return a.status === "published" && a.reviewStatus === "rejected";
  });

  const draftCount = rows.filter((a) => a.status === "draft").length;

  function flash(ok: string, error = "") {
    setMsg(ok);
    setErr(error);
    if (ok || error) setTimeout(() => { setMsg(""); setErr(""); }, 2600);
  }

  async function withdraw(slug: string) {
    if (busy) return;
    if (!confirm("确定撤回这篇文章？前台将立即不可见（数据保留，可联系管理员恢复）。")) return;
    setBusy(slug);
    try {
      const res = await fetch(`/api/articles/${slug}`, { method: "DELETE" });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) flash("", d.error ?? "撤回失败");
      else {
        flash("已撤回");
        router.refresh();
      }
    } catch {
      flash("", "网络异常");
    } finally {
      setBusy("");
    }
  }

  async function removeDraft(slug: string) {
    if (busy) return;
    if (!confirm("草稿将被彻底删除，不可恢复。确定？")) return;
    setBusy(slug);
    try {
      const res = await fetch(`/api/articles/${slug}`, { method: "DELETE" });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) flash("", d.error ?? "删除失败");
      else {
        flash("草稿已删除");
        router.refresh();
      }
    } catch {
      flash("", "网络异常");
    } finally {
      setBusy("");
    }
  }

  async function publishDraft(slug: string) {
    if (busy) return;
    setBusy(slug);
    try {
      // 仅发布模式：不带内容，正文保持草稿原样（服务端 publishOnly 分支）
      const res = await fetch(`/api/articles/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish: true }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) flash("", d.error ?? "发布失败");
      else {
        flash("草稿已发布 · 进入审核队列");
        router.refresh();
      }
    } catch {
      flash("", "网络异常");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="study-list">
      <div className="adm-tabs" role="tablist" aria-label="文章状态筛选">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={"adm-tab" + (tab === t.key ? " on" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "draft" && draftCount > 0 && <i className="tab-badge">{draftCount}</i>}
          </button>
        ))}
        {(msg || err) && <span className={err ? "mig-error" : "adm-ok"}>{err ? `✕ ${err}` : msg}</span>}
      </div>

      {shown.length === 0 ? (
        <p className="admin-denied">
          {tab === "draft"
            ? "草稿箱是空的。创作台写完点「存草稿」（或 Ctrl+S）就能把灵感先收进来。"
            : "这里还空着。去 AI 创作台写第一篇，或用迁移工坊把旧博客搬进来。"}
        </p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>文章</th>
              <th>状态</th>
              <th>数据</th>
              <th>更新</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const st = statusOf(a);
              const publicVisible = a.status === "published" && a.reviewStatus === "approved";
              const isDraft = a.status === "draft";
              const barW = Math.max(4, Math.round((a.readCount / maxReads) * 100));
              return (
                <tr key={a.slug} className={a.status === "removed" ? "row-removed" : ""}>
                  <td className="cell-title">
                    {publicVisible ? (
                      <a href={`/article/${a.slug}`} target="_blank" rel="noopener">
                        {a.title}
                      </a>
                    ) : (
                      <span>{a.title}</span>
                    )}
                    {a.boostUntil && <span className="tag-chip hot">加热中</span>}
                    {a.reviewStatus === "rejected" && a.reviewNote && (
                      <small className="reject-note">驳回原因：{a.reviewNote}</small>
                    )}
                  </td>
                  <td>
                    <span className={"status " + st.cls}>{st.label}</span>
                  </td>
                  <td className="cell-meta cell-data">
                    <span className="read-bar-wrap">
                      <i className="read-bar" style={{ width: `${barW}%` }} />
                      <span>{a.readCount.toLocaleString()} 阅</span>
                    </span>
                    <small>
                      {a.likeCount} 赞 · {a.commentCount} 评 · {a.agentQaCount} 问
                      {a.tipTotal > 0 ? ` · 赏 ${a.tipTotal}` : ""}
                    </small>
                  </td>
                  <td className="cell-meta">{a.updatedAt}</td>
                  <td className="cell-actions">
                    <a className="mini-btn" href={`/studio?edit=${encodeURIComponent(a.slug)}`}>
                      编辑
                    </a>
                    {isDraft && (
                      <>
                        <button className="mini-btn go" disabled={!!busy} onClick={() => publishDraft(a.slug)}>
                          发布
                        </button>
                        <button className="mini-btn warn" disabled={!!busy} onClick={() => removeDraft(a.slug)}>
                          删除
                        </button>
                      </>
                    )}
                    {a.status === "published" && (
                      <button className="mini-btn warn" disabled={!!busy} onClick={() => withdraw(a.slug)}>
                        撤回
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
