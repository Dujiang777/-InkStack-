// POST /api/auth/logout — 吊销服务器端会话 + 清除 Cookie（v13.5：登出即刻失效）
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";
import { clearSessionCookie, readSessionToken, sha256Hex } from "@/lib/auth";
import { logAudit, clientIp, clientUa } from "@/lib/audit";

export async function POST(req: Request) {
  if (dbEnabled()) {
    try {
      const token = await readSessionToken();
      if (token) {
        const { getCurrentUser } = await import("@/lib/auth");
        const { getPool } = await import("@/lib/db");
        const me = await getCurrentUser().catch(() => null);
        const pool = await getPool();
        if (pool) {
          await pool.query(`UPDATE sessions SET revoked = 1 WHERE token_hash = ?`, [sha256Hex(token)]);
          await logAudit(pool, "logout", me?.id ?? null, { ip: clientIp(req), ua: clientUa(req) });
        }
      }
    } catch {
      /* 登出审计失败不影响登出 */
    }
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
