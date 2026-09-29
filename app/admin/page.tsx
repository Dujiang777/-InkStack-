import { dbEnabled } from "@/lib/db";
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
import { javaReady, remoteAdminOverview } from "@/lib/java-source";
import { getCurrentUser, isStaff } from "@/lib/auth";
import AdminConsole from "@/components/AdminConsole";

// 运营台（完整版）：总览 / 审核 / 内容 / 用户 / 举报 / 日志 / 评论 / 资金
// 权限：admin 与 developer（v17.1）；DB 未配置（演示模式）时展示演示数据预览
export default async function AdminPage() {
  const user = await getCurrentUser();
  const demoMode = !dbEnabled();
  // "实时数据"这块牌子要配得上：MySQL 与 JAVA_BASE 缺任何一头，页面上就是兜底假数
  const live = javaReady();

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

  const overview = demoMode || !live ? null : await remoteAdminOverview();

  const data = {
    articles: await adminListArticles(),
    review: await adminListReview(),
    users: await adminListUsers(),
    reports: await adminListReports(),
    logs: await adminListActions(),
  };

  // 演示模式兜底（DB 不可用时仍可预览界面）：只兜"数字"，不兜任何一条真读数
  const stats = overview
    ? overview.stats
    : { users: 128, articles: 342, pending: 3, comments: 1284, qa: 4200, reports: 1, tips: 920, topup: 6600, banned: 0 };
  const recentQa = overview?.recentQa.length
    ? overview.recentQa
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
        <span className="admin-flag">
          {demoMode ? "演示数据 · 未配置 MySQL" : live ? "实时数据" : "演示数据 · 未配置 JAVA_BASE"}
        </span>
      </div>
      <AdminConsole
        stats={stats}
        recentQa={recentQa}
        articles={data.articles}
        review={data.review}
        users={data.users}
        reports={data.reports}
        logs={data.logs}
        insights={insights}
        orders={orders}
        commentRows={commentRows}
        viewerRole={user?.role ?? "admin"}
      />
    </div>
  );
}
