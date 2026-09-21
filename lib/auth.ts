// 认证层（v13.5 安全巅峰版）：
// - 密码：node crypto scrypt 加盐哈希（64 字节派生，恒时比较）
// - 会话：HMAC-SHA256 签名 Cookie + 服务器端 sessions 表双保险
//   → 支持设备管理、强制下线、按令牌吊销（纯无状态 Cookie 做不到）
// - 令牌哈希入库（sha256）：库泄露也无法还原会话令牌
// - 2FA 列：totp_secret / totp_enabled / totp_backup（一次性备份码 sha256 JSON）
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getPool, dbEnabled } from "./db";

const SECRET = process.env.SESSION_SECRET || "inkstack-dev-secret-change-me";
// 安全底线：生产环境绝不允许弱默认密钥（可被伪造任意用户会话）
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === "production") {
  console.error("[auth] 危险：SESSION_SECRET 未配置，生产环境使用默认密钥等于裸奔！请立即在 .env 设置强随机值。");
}
export const SESSION_COOKIE = "ink_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 天

export type SessionUser = {
  id: number;
  nickname: string;
  email: string;
  role: string;
  points: number;
};

/* ---------- 角色体系（v17.1）：developer > admin > author > user ---------- */
/** 运营侧权限：admin 与 developer 均可进运营台；role 管理仅 developer 可用 */
export function isStaff(role: string | undefined | null): boolean {
  return role === "admin" || role === "developer";
}

/* ---------- 昵称净化（v17.7） ---------- */
/**
 * 昵称统一净化：剥离控制字符/零宽字符、折叠连续空白、trim、按长度截断。
 *
 * 为什么必须做：昵称不只在页面里展示（React 会转义），它还会被拼进
 *   - 欢迎邮件的 **Subject 头** 与 **HTML 正文**（lib/mailer.ts）
 *   - 通知标题、审计日志行
 * 而 5 个入口里有 3 个是**第三方 OAuth 返回的昵称**（GitHub / Gitee / QQ），
 * 完全不受我方控制。实测 nodemailer 会把 CRLF 编码掉（不会造成邮件头注入），
 * 但这属于「依赖下游库兜底」——入口处过滤才是根因收口（第 7 轮巡检加固）。
 */
export function cleanNickname(raw: unknown, max = 20): string {
  return String(raw ?? "")
    // C0/C1 控制字符 + BOM + 零宽字符 + 行分隔符（\r\n\t 一并去掉）
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

/* ---------- 懒迁移：sessions / audit_logs 表 + users 2FA 列（老库平滑升级） ---------- */
const gSec = globalThis as typeof globalThis & { __inkSecReady?: boolean };
export async function ensureSecurityTables(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>): Promise<void> {
  if (gSec.__inkSecReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id      BIGINT UNSIGNED NOT NULL,
    token_hash   CHAR(64) NOT NULL,
    ua           VARCHAR(255) NULL,
    ip           VARCHAR(64)  NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at   DATETIME NOT NULL,
    revoked      TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uk_session_token (token_hash),
    INDEX idx_session_user (user_id, revoked)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NULL,
    event      VARCHAR(32) NOT NULL,
    ip         VARCHAR(64)  NULL,
    ua         VARCHAR(255) NULL,
    detail     VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_user (user_id, created_at DESC),
    INDEX idx_audit_event (event, created_at DESC)
  ) ENGINE=InnoDB`);
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('totp_secret','totp_enabled','totp_backup')`
  );
  const have = new Set((cols as { COLUMN_NAME: string }[]).map((r) => r.COLUMN_NAME));
  if (!have.has("totp_secret")) await pool.query(`ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL`);
  if (!have.has("totp_enabled")) await pool.query(`ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0`);
  if (!have.has("totp_backup")) await pool.query(`ALTER TABLE users ADD COLUMN totp_backup TEXT NULL COMMENT '一次性备份码 sha256 JSON 数组'`);
  gSec.__inkSecReady = true;
}

/* ---------- 密码 ---------- */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const calc = scryptSync(pw, salt, 64);
  const orig = Buffer.from(hash, "hex");
  return calc.length === orig.length && timingSafeEqual(calc, orig);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/* ---------- 会话令牌（签名 payload {sid, uid, exp}） ---------- */
function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function makeSessionToken(uid: number): { token: string; sid: string; expMs: number } {
  const sid = randomBytes(18).toString("hex");
  const expMs = Date.now() + MAX_AGE * 1000;
  const payload = Buffer.from(JSON.stringify({ sid, uid, exp: expMs })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, sid, expMs };
}

type ParsedToken = { sid: string; uid: number; exp: number } | null;

export function parseSessionToken(token: string | undefined): ParsedToken {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expect = sign(payload);
  const a = Buffer.from(expect);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      sid: string;
      uid: number;
      exp: number;
    };
    if (!data.sid || !data.uid || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/* ---------- Cookie 操作（仅可在 Route Handler / Server Action 中调用） ---------- */
// 创建服务器端会话记录（设备管理数据源）；meta 缺省时只落最小信息
export async function setSessionCookie(
  uid: number,
  meta?: { ip?: string; ua?: string }
): Promise<void> {
  const { token, expMs } = makeSessionToken(uid);
  const pool = await getPool();
  if (pool && dbEnabled()) {
    try {
      await ensureSecurityTables(pool);
      await pool.query(
        `INSERT INTO sessions (user_id, token_hash, ua, ip, expires_at)
         VALUES (?, ?, ?, ?, FROM_UNIXTIME(?))`,
        [uid, sha256Hex(token), (meta?.ua ?? "").slice(0, 250) || null, (meta?.ip ?? "").slice(0, 60) || null, Math.floor(expMs / 1000)]
      );
    } catch (e) {
      console.error("[auth] 会话入库失败（降级为纯 Cookie 会话）:", e instanceof Error ? e.message : e);
    }
  }
  const jar = await cookies();
  // v15.2：secure 标志跟随站点协议——http 部署（如临时 IP 站）下绝不能带 secure，
  // 否则浏览器拒收会话 Cookie，所有登录方式都会"认证成功却保持游客态"。
  // NEXT_PUBLIC_SITE_URL 是 https 时（正式域名上线后）自动恢复 secure；INSECURE_COOKIE=1 可强制关闭。
  const siteIsHttps = (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    ...(siteIsHttps && process.env.INSECURE_COOKIE !== "1" ? { secure: true } : {}),
  });
}

export async function readSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value;
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

/* ---------- 服务器端会话校验与吊销 ---------- */
const gSeen = globalThis as typeof globalThis & { __inkSeen?: Map<string, number> };
const seenMap = (gSeen.__inkSeen ??= new Map<string, number>());

export async function getCurrentUser(): Promise<SessionUser | null> {
  if (!dbEnabled()) return null;
  const token = await readSessionToken();
  const parsed = parseSessionToken(token);
  if (!parsed) return null;
  const pool = await getPool();
  if (!pool) return null;
  try {
    await ensureSecurityTables(pool);
    // 双保险：签名 + 库内会话有效（未被吊销/未过期）
    const [rows] = await pool.query(
      `SELECT s.id AS session_id, s.token_hash, u.id, u.nickname, u.email, u.role, u.points_balance, u.banned
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > NOW() LIMIT 1`,
      [sha256Hex(token as string)]
    );
    const r = (rows as Record<string, unknown>[])[0];
    if (!r || Number(r.id) !== parsed.uid) return null;
    if (Number(r.banned) === 1) return null;
    // last_seen 节流写：60s 内不重复 UPDATE（避免每请求一次写放大）
    const sidKey = String(r.session_id);
    const last = seenMap.get(sidKey) ?? 0;
    if (Date.now() - last > 60_000) {
      seenMap.set(sidKey, Date.now());
      pool.query(`UPDATE sessions SET last_seen_at = NOW() WHERE id = ?`, [r.session_id]).catch(() => {});
    }
    return {
      id: Number(r.id),
      nickname: String(r.nickname),
      email: String(r.email),
      role: String(r.role),
      points: Number(r.points_balance),
    };
  } catch {
    return null;
  }
}

export type SessionRow = {
  id: number;
  ua: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
};

export async function listSessions(uid: number): Promise<SessionRow[]> {
  const pool = await getPool();
  if (!pool) return [];
  const currentToken = await readSessionToken();
  const currentHash = currentToken ? sha256Hex(currentToken) : "";
  const [rows] = await pool.query(
    `SELECT id, token_hash, ua, ip, created_at, last_seen_at
       FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > NOW()
      ORDER BY last_seen_at DESC LIMIT 30`,
    [uid]
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    ua: (r.ua as string) ?? null,
    ip: (r.ip as string) ?? null,
    created_at: String(r.created_at),
    last_seen_at: String(r.last_seen_at),
    current: String(r.token_hash) === currentHash,
  }));
}

/** 吊销指定会话（校验属主，防越权下线他人） */
export async function revokeSession(uid: number, sid: number): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  const [r] = await pool.query(
    `UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?`,
    [sid, uid]
  );
  return Number((r as { affectedRows: number }).affectedRows) > 0;
}

/** 吊销除当前会话外的所有会话（「在其他设备上退出」）；keepCurrent=false 时全下线 */
export async function revokeOtherSessions(uid: number, keepCurrent: boolean): Promise<number> {
  const pool = await getPool();
  if (!pool) return 0;
  if (keepCurrent) {
    const currentToken = await readSessionToken();
    const currentHash = currentToken ? sha256Hex(currentToken) : "";
    const [r] = await pool.query(
      `UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0 AND token_hash <> ?`,
      [uid, currentHash]
    );
    return Number((r as { affectedRows: number }).affectedRows);
  }
  const [r] = await pool.query(`UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0`, [uid]);
  return Number((r as { affectedRows: number }).affectedRows);
}
