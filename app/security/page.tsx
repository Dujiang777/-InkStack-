// /security 安全中心（v13.5）：登录历史 · 设备管理 · 改密 · 两步验证
// 服务端取数：会话列表 + 审计日志（只取本人）；交互在 SecurityClient
import { redirect } from "next/navigation";
import { getCurrentUser, listSessions } from "@/lib/auth";
import { getPool } from "@/lib/db";
import SecurityClient from "@/components/SecurityClient";

export const dynamic = "force-dynamic";

export type AuditRow = {
  id: number;
  event: string;
  ip: string | null;
  detail: string | null;
  created_at: string;
};

export default async function SecurityPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login?next=/security");

  const sessions = await listSessions(me.id);
  let audits: AuditRow[] = [];
  const pool = await getPool();
  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT id, event, ip, detail, created_at FROM audit_logs
          WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
        [me.id]
      );
      audits = (rows as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id),
        event: String(r.event),
        ip: (r.ip as string) ?? null,
        detail: (r.detail as string) ?? null,
        created_at: String(r.created_at),
      }));
    } catch {
      /* 审计查询失败不阻塞页面 */
    }
  }

  // 2FA 状态
  let totpEnabled = false;
  if (pool) {
    try {
      const [rows] = await pool.query("SELECT totp_enabled FROM users WHERE id = ? LIMIT 1", [me.id]);
      totpEnabled = Number((rows as Record<string, unknown>[])[0]?.totp_enabled ?? 0) === 1;
    } catch {
      /* 默认未开启 */
    }
  }

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
