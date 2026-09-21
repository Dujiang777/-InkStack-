// 内存滑窗限流器（单实例 dev/个人部署够用；多实例部署时换 Redis）
// 用法：hit(key, opts) → { locked, retryAfterSec, fails }；成功后 clear(key)
const g = globalThis as typeof globalThis & {
  __inkRateBuckets?: Map<string, number[]>;
};
const buckets = (g.__inkRateBuckets ??= new Map<string, number[]>());

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
};

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

function limits(opts?: RateOpts): { max: number; windowMs: number } {
  return {
    max: opts?.max ?? DEFAULT_MAX,
    windowMs: opts?.windowMs ?? DEFAULT_WINDOW_MS,
  };
}

function sweep(key: string, now: number, windowMs: number): number[] {
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length === 0) buckets.delete(key);
  else buckets.set(key, arr);
  return arr;
}

/** 记一次 */
export function hit(key: string, opts?: RateOpts): RateVerdict {
  const now = Date.now();
  const { max, windowMs } = limits(opts);
  const arr = sweep(key, now, windowMs);
  arr.push(now);
  buckets.set(key, arr);
  const locked = arr.length >= max;
  return {
    locked,
    retryAfterSec: locked ? Math.ceil((windowMs - (now - arr[0])) / 1000) : 0,
    fails: arr.length,
  };
}

/** 只查不记 */
export function verdict(key: string, opts?: RateOpts): RateVerdict {
  const now = Date.now();
  const { max, windowMs } = limits(opts);
  const arr = sweep(key, now, windowMs);
  const locked = arr.length >= max;
  return {
    locked,
    retryAfterSec: locked ? Math.ceil((windowMs - (now - arr[0])) / 1000) : 0,
    fails: arr.length,
  };
}

/** 成功后清零 */
export function clear(key: string): void {
  buckets.delete(key);
}
