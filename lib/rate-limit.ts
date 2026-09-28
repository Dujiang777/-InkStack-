// 共享存储限流器：失败计数落在 MySQL 的 rate_hits 表里，Node 与 Java 读同一份账。
//
// 为什么不是内存桶：双轨期同一个 key 会被两栈分别计数，一个 IP 的真实容忍度接近两栈之和，
// 而且切流量那一刻进程重启、计数清零——爆破者只要卡住切换点就能白得 5 次机会。
//
// 为什么窗口时钟用 MySQL 的 NOW(3) 而不是两边的 Date.now()：判定要用「窗口内最早一次命中
// 距今多久」算 Retry-After，两台机器的钟只要漂移，同一个桶在两边就会算出不同的解锁时间。
// 写入、比较、求 age 全部交给同一个数据库，两栈才可能给出同一个答案。
//
// 用法：hit(key, opts) → { locked, retryAfterSec, fails }；成功后 clear(key)
import type { Pool } from "mysql2/promise";
import { getPool } from "./db";

export type RateOpts = {
  /** 窗口内允许的最大次数（达到即锁定） */
  max?: number;
  /** 滑窗时长（毫秒） */
  windowMs?: number;
};

export type RateVerdict = {
  /** 是否已被锁定（窗口内次数达上限） */
  locked: boolean;
  /** 距解锁秒数（locked 时有意义） */
  retryAfterSec: number;
  /** 窗口内已记次数 */
  fails: number;
  /** 本桶上限（回给调用方拼提示语，免得各处硬编码 5） */
  max: number;
};

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
/** 全表清扫周期：桶名带 email+ip，一次性桶不会被再次读到，本地 per-bucket 清扫清不掉它们 */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
/** 保留 1 天后全删：窗口最长 15 分钟，留一天纯粹是给排障看的 */
const RETENTION_SEC = 24 * 60 * 60;

function limits(opts?: RateOpts): { max: number; windowMs: number } {
  return {
    max: opts?.max ?? DEFAULT_MAX,
    windowMs: opts?.windowMs ?? DEFAULT_WINDOW_MS,
  };
}

// 数据库不可用时放行而不是锁死：限流器自己挂了不该把全站登录变 500，
// 也不该把"读不到计数"误判成"读到了很多计数"。代价是这一段时间无防护，只在进程日志里 WARN。
let warned = false;
function failOpen(err: unknown, max: number): RateVerdict {
  if (!warned) {
    warned = true;
    console.warn(`[rate-limit] 计数库不可用，限流暂时放行（本进程只 WARN 这一次）：${String(err)}`);
  }
  return { locked: false, retryAfterSec: 0, fails: 0, max };
}

let lastSweepAt = 0;
async function sweepGlobal(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = now;
  await pool.query(`DELETE FROM rate_hits WHERE ts < DATE_SUB(NOW(3), INTERVAL ${RETENTION_SEC} SECOND)`);
}

async function count(pool: Pool, key: string, windowMs: number): Promise<{ n: number; ageMs: number }> {
  // ageMs：窗口内最早一次命中距今的毫秒数。SQL 文本与 Java 的 RateHitMapper 逐字相同，
  // 两栈才会对同一个桶给出同一个 Retry-After。
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n,
            COALESCE(ROUND((UNIX_TIMESTAMP(NOW(3)) - UNIX_TIMESTAMP(MIN(ts))) * 1000), 0) AS age_ms
       FROM rate_hits
      WHERE bucket = ? AND ts > DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
    [key, Math.ceil(windowMs / 1000)]
  );
  const r = (rows as { n: number | string; age_ms: number | string }[])[0];
  return { n: Number(r?.n ?? 0), ageMs: Number(r?.age_ms ?? 0) };
}

function verdictOf(n: number, ageMs: number, max: number, windowMs: number): RateVerdict {
  const locked = n >= max;
  return {
    locked,
    retryAfterSec: locked ? Math.ceil((windowMs - ageMs) / 1000) : 0,
    fails: n,
    max,
  };
}

/** 记一次 */
export async function hit(key: string, opts?: RateOpts): Promise<RateVerdict> {
  const { max, windowMs } = limits(opts);
  const pool = await getPool();
  if (!pool) return failOpen("DATABASE_URL 未配置", max);
  try {
    // 先扫掉本桶的过期行，窗口内计数就不会被历史值撑大
    await pool.query(`DELETE FROM rate_hits WHERE bucket = ? AND ts <= DATE_SUB(NOW(3), INTERVAL ? SECOND)`, [
      key,
      Math.ceil(windowMs / 1000),
    ]);
    await pool.query(`INSERT INTO rate_hits (bucket, ts) VALUES (?, NOW(3))`, [key]);
    sweepGlobal(pool).catch(() => undefined);
    const { n, ageMs } = await count(pool, key, windowMs);
    return verdictOf(n, ageMs, max, windowMs);
  } catch (err) {
    return failOpen(err, max);
  }
}

/** 只查不记 */
export async function verdict(key: string, opts?: RateOpts): Promise<RateVerdict> {
  const { max, windowMs } = limits(opts);
  const pool = await getPool();
  if (!pool) return failOpen("DATABASE_URL 未配置", max);
  try {
    const { n, ageMs } = await count(pool, key, windowMs);
    return verdictOf(n, ageMs, max, windowMs);
  } catch (err) {
    return failOpen(err, max);
  }
}

/** 成功后清零 */
export async function clear(key: string): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await pool.query(`DELETE FROM rate_hits WHERE bucket = ?`, [key]);
  } catch (err) {
    failOpen(err, DEFAULT_MAX);
  }
}
