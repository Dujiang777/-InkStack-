// /security 安全中心（v13.5）：登录历史 · 设备管理 · 改密 · 两步验证
// 服务端取数：会话列表 + 审计日志（只取本人）；交互在 SecurityClient
import { redirect } from "next/navigation";
import { getCurrentUser, listSessions } from "@/lib/auth";
import { javaReady, remoteSecurityOverview } from "@/lib/java-source";
import SecurityClient from "@/components/SecurityClient";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login?next=/security");

  const sessions = await listSessions(me.id);
  // 留痕 20 条 + 两步验证开关，原本是两句就地的 pool.query（P7f-1f-a 迁给 Java）。
  // created_at 回 ISO 串这一点没变：组件用 new Date(s.replace(" ","T")) 解析，
  // 回 MySQL 那种 "Mon Sep 21 ..." 会让这一栏显示 Invalid Date——Node 侧已经踩过。
  const overview = javaReady() ? await remoteSecurityOverview() : null;
  const audits = overview?.audits ?? [];
  const totpEnabled = overview?.totpEnabled ?? false;

  return (
    <div className="security-page">
      <p className="kicker">ACCOUNT FORTRESS · 账号要塞</p>
      <h1 className="sec-title">安全中心</h1>
      <p className="sec-sub">
        会话入库 · 设备可下线 · 两步验证 · 全操作留痕 —— {me.nickname}，这里是你账号的城墙。
      </p>
      <SecurityClient
        email={me.email}
        nickname={me.nickname}
        totpEnabled={totpEnabled}
        sessions={sessions}
        audits={audits}
      />
    </div>
  );
}
