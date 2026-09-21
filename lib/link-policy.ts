// 链接审核策略：白名单域名直接放行，其余提交审核
// P0：默认白名单（代码/文档/社区站）+ links 表（pending/approved/rejected）
import { getPool } from "./db";

const DEFAULT_ALLOW = [
  "github.com", "gitee.com", "stackoverflow.com", "npmjs.com", "pypi.org",
  "developer.mozilla.org", "nodejs.org", "python.org", "react.dev", "nextjs.org",
  "mysql.com", "agentscope.io", "deepseek.com", "juejin.cn", "csdn.net",
  "zhihu.com", "segmentfault.com", "ruanyifeng.com", "v2ex.com",
];

export function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 加载当前全部放行域名（DB 优先，失败用默认） */
export async function allowedDomains(): Promise<Set<string>> {
  const set = new Set(DEFAULT_ALLOW);
  const pool = await getPool();
  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT domain FROM link_whitelist WHERE status = 'approved'`
      );
      for (const r of rows as Record<string, unknown>[]) {
        set.add(String(r.domain).toLowerCase());
      }
    } catch {
      /* 降级默认 */
    }
  }
  return set;
}

/** 外链提交审核（P0：自动入库为 pending，admin 在运营台批准） */
export async function submitLinkForReview(url: string, note = ""): Promise<void> {
  const domain = extractDomain(url);
  if (!domain) return;
  const pool = await getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO link_whitelist (domain, url, note, status) VALUES (?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE url = VALUES(url)`,
      [domain, url.slice(0, 500), note.slice(0, 200)]
    );
  } catch {
    /* 静默：审核库不可用时不阻塞发布 */
  }
}
