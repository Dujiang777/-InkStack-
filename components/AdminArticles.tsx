"use client";

// 运营台内容管理表：下架/发布/置顶/精选操作，操作后 router.refresh() 拉新数据
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AdminArticleRow } from "@/lib/data";

const STATUS_LABEL: Record<string, string> = {
  published: "已发布",
  draft: "草稿",
  removed: "已下架",
};

export default function AdminArticles({ rows }: { rows: AdminArticleRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function act(slug: string, action: string, extra?: Record<string, unknown>) {
    if (busy) return;
    if (action === "unpublish" && !confirm(`确定下架《${slug}》？前台将立即不可见。`)) return;
    setBusy(slug + action);
    setError("");
    try {
      const res = await fetch("/api/admin/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "操作失败");
      else router.refresh();
    } catch {
      setError("网络异常");
    } finally {
      setBusy("");
    }
  }

  /* v17.1：运营改价（解锁价 + 限时折扣，0 = 关闭付费墙） */
  function editPrice(slug: string, current: number) {
    const up = prompt(`《${slug}》解锁价（点墨，0 = 关闭付费墙）：`, String(current || 0));
    if (up === null) return;
    const unlockPrice = Math.floor(Number(up) || 0);
    if (unlockPrice < 0) {
      setError("价格不能为负数");
      return;
    }
    let discountPrice = 0;
    if (unlockPrice > 0) {
      const dp = prompt(`限时折扣价（点墨，0 = 不打折）：`, "0");
      if (dp === null) return;
      discountPrice = Math.floor(Number(dp) || 0);
      if (discountPrice < 0 || discountPrice > unlockPrice) {
        setError("折扣价须在 0 与解锁价之间");
        return;
      }
    }
    act(slug, "price", { unlockPrice, discountPrice });
  }

  if (!rows.length) {
    return <p className="admin-denied">暂无文章数据。</p>;
  }

  return (
    <div className="admin-articles">
      {error && <p className="mig-error">✕ {error}</p>}
      <table className="admin-table">
        <thead>
          <tr>
            <th>文章</th>
            <th>作者</th>
            <th>状态</th>
            <th>数据</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.slug} className={a.status === "removed" ? "row-removed" : ""}>
              <td className="cell-title">
                {a.status === "published" ? (
                  <a href={`/article/${a.slug}`} target="_blank" rel="noopener">{a.title}</a>
                ) : (
                  <span>{a.title}</span>
                )}
                <span className="aflags">
                  {a.pinned && <i className="flag pin">置顶</i>}
                  {a.featured && <i className="flag feat">精选</i>}
                </span>
              </td>
              <td>{a.author}</td>
              <td>
                <span className={"status st-" + a.status}>{STATUS_LABEL[a.status] ?? a.status}</span>
                {a.reviewStatus === "pending" && <span className="status st-pending">待审核</span>}
                {a.reviewStatus === "rejected" && <span className="status st-rejected" title="作者改后可重提">未通过</span>}
              </td>
              <td className="cell-meta">
                {a.readCount} 阅 · {a.commentCount} 评
                <br />
                <small>{a.publishedAt}</small>
              </td>
              <td className="cell-actions">
                {a.status === "published" ? (
                  <button className="mini-btn warn" disabled={!!busy} onClick={() => act(a.slug, "unpublish")}>下架</button>
                ) : (
                  <button className="mini-btn" disabled={!!busy} onClick={() => act(a.slug, "publish")}>发布</button>
                )}
                {a.status === "published" && (
                  <>
                    <button className="mini-btn" disabled={!!busy} onClick={() => act(a.slug, a.pinned ? "unpin" : "pin")}>
                      {a.pinned ? "取消置顶" : "置顶"}
                    </button>
                    <button className="mini-btn" disabled={!!busy} onClick={() => act(a.slug, a.featured ? "unfeature" : "feature")}>
                      {a.featured ? "取消精选" : "精选"}
                    </button>
                    <button className="mini-btn ghost" disabled={!!busy} onClick={() => editPrice(a.slug, a.unlockPrice)}>
                      {a.unlockPrice > 0 ? `改价·${a.unlockPrice}` : "改价"}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
