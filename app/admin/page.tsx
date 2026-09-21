import { getPool, dbEnabled } from "@/lib/db";
import {
  adminListArticles,
  adminListReview,
  adminListUsers,
  adminListReports,
  adminListActions,
  adminListOrders,
  adminListComments,
  adminInsights,
} from "@/lib/data";
import { getCurrentUser, isStaff } from "@/lib/auth";
import AdminConsole from "@/components/AdminConsole";

// 运营台（完整版）：总览 / 审核 / 内容 / 用户 / 举报 / 日志 / 评论 / 资金
// 权限：admin 与 developer（v17.1）；DB 未配置（演示模式）时展示演示数据预览
export default async function AdminPage() {
  const pool = await getPool();
  const user = await getCurrentUser();
  const demoMode = !dbEnabled();

  if (!demoMode && (!user || !isStaff(user.role))) {
    return (
      <div className="admin-page">
        <div className="section-head">
          <h2>运营台</h2>
        </div>
        <p className="admin-denied">仅管理团队可见。如需提升权限请联系平台所有者。</p>
      </div>
    );
  }

  const empty = {
    stats: { users: 0, articles: 0, pending: 0, comments: 0, qa: 0, reports: 0, tips: 0, topup: 0, banned: 0 },
    recentQa: [] as { question: string; createdAt: string }[],
    articles: await adminListArticles(),
    review: await adminListReview(),
    users: await adminListUsers(),
    reports: await adminListReports(),
    logs: await adminListActions(),
  };

  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='approved') AS articles,
           (SELECT COUNT(*) FROM articles WHERE status='published' AND review_status='pending') AS pending,
           (SELECT COUNT(*) FROM comments) AS comments,
           (SELECT COUNT(*) FROM agent_qa) AS qa,
           (SELECT COUNT(*) FROM reports WHERE status='open') AS reports,
           (SELECT IFNULL(SUM(amount),0) FROM article_tips) AS tips,
           (SELECT IFNULL(SUM(points),0) FROM topup_orders WHERE status='paid') AS topup,
           (SELECT COUNT(*) FROM users WHERE banned=1) AS banned`
      );
      const r = (rows as Record<string, unknown>[])[0];
      if (r) {
        empty.stats = {
          users: Number(r.users),
          articles: Number(r.articles),
          pending: Number(r.pending),
          comments: Number(r.comments),
          qa: Number(r.qa),
          reports: Number(r.reports),
          tips: Number(r.tips),
          topup: Number(r.topup),
          banned: Number(r.banned),
        };
      }
      const [qaRows] = await pool.query(
        `SELECT question, DATE_FORMAT(created_at,'%m-%d %H:%i') AS createdAt
         FROM agent_qa ORDER BY created_at DESC LIMIT 8`
      );
      empty.recentQa = (qaRows as Record<string, unknown>[]).map((q) => ({
        question: String(q.question),
        createdAt: String(q.createdAt),
      }));
    } catch {
      /* 统计失败时保底空数据 */
    }
  }

  // 演示模式兜底（DB 不可用时仍可预览界面）
  const stats = pool
    ? empty.stats
    : { users: 128, articles: 342, pending: 3, comments: 1284, qa: 4200, reports: 1, tips: 920, topup: 6600, banned: 0 };
  const recentQa = empty.recentQa.length
    ? empty.recentQa
    : [
        { question: "为什么 then 要进微任务？", createdAt: "09-09 15:12" },
        { question: "循环 thenable 的 TypeError 具体怎么检测？", createdAt: "09-09 14:58" },
        { question: "pgvector 的 HNSW 参数怎么调？", createdAt: "09-09 13:20" },
      ];

  const insights = await adminInsights();
  const orders = await adminListOrders();
  const commentRows = await adminListComments();

  return (
    <div className="admin-page">
      <div className="section-head">
        <h2>运营台 · InkStack Console</h2>
        <span className="admin-flag">{demoMode ? "演示数据 · 未配置 MySQL" : "实时数据"}</span>
      </div>
      <AdminConsole
        stats={stats}
        recentQa={recentQa}
        articles={empty.articles}
        review={empty.review}
        users={empty.users}
        reports={empty.reports}
        logs={empty.logs}
        insights={insights}
        orders={orders}
        commentRows={commentRows}
        viewerRole={user?.role ?? "admin"}
      />
    </div>
  );
}
