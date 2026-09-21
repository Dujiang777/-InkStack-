// 安全审计日志：登录/登出/注册/改密/2FA/设备下线等敏感事件全留痕（append-only）
// 写入失败静默降级 —— 审计绝不阻塞主流程
import type { Pool } from "mysql2/promise";

export type AuditEvent =
  | "login_ok"
  | "login_fail"
  | "login_2fa"
  | "logout"
  | "register"
  | "password_change"
  | "password_reset"
  | "totp_enable"
  | "totp_disable"
  | "session_revoke";

export async function logAudit(
  pool: Pool,
  event: AuditEvent,
  userId: number | null,
  opts?: { ip?: string; ua?: string; detail?: string }
): Promise<void> {
  try {
    await pool.query(
      "INSERT INTO audit_logs (user_id, event, ip, ua, detail) VALUES (?, ?, ?, ?, ?)",
      [
        userId,
        event,
        (opts?.ip ?? "").slice(0, 60) || null,
        (opts?.ua ?? "").slice(0, 250) || null,
        (opts?.detail ?? "").slice(0, 250) || null,
      ]
    );
  } catch (e) {
    console.error("[audit] 写入失败:", e instanceof Error ? e.message : e);
  }
}

export function clientIp(req: Request): string {
  // v15.0：与 middleware 同策略——TRUST_PROXY=1 时信 x-real-ip / XFF 末跳（审计日志取真实对端）
  const trustProxy = process.env.TRUST_PROXY === "1";
  const xffList = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const realIp = (req.headers.get("x-real-ip") ?? "").trim();
  if (trustProxy) return realIp || xffList[xffList.length - 1] || "local";
  return xffList[0] || realIp || "local";
}

export function clientUa(req: Request): string {
  return req.headers.get("user-agent") ?? "";
}
