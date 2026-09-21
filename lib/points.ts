// 积分层（P0）：事务扣减 + 流水记录。免费额度 100 分由注册时的列默认值发放。
// P1 升级点：每日 100 分定时重置（可用登录时懒重置实现）、充值套餐。
import { getPool } from "./db";

export async function spendPoints(
  userId: number,
  cost: number,
  reason: string
): Promise<{ ok: boolean; error?: string; balance?: number }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库未配置" };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      "SELECT points_balance FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    const bal = Number((rows as Record<string, unknown>[])[0]?.points_balance ?? 0);
    if (bal < cost) {
      await conn.rollback();
      return { ok: false, error: `积分不足（余额 ${bal}，本次需 ${cost}）` };
    }
    await conn.query("UPDATE users SET points_balance = points_balance - ? WHERE id = ?", [
      cost,
      userId,
    ]);
    await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
      userId,
      -cost,
      reason,
    ]);
    await conn.commit();
    return { ok: true, balance: bal - cost };
  } catch {
    await conn.rollback();
    return { ok: false, error: "积分服务异常，请稍后再试" };
  } finally {
    conn.release();
  }
}

// 只读余额探针（v17.4）：给「先生成后扣费」的链路做前置拦截用。
// 不参与计费、不加锁、不落流水——仅为避免余额不足的用户白耗上游 LLM token；
// 真正的扣款仍由 spendPoints 在「上游确认可用」后以 FOR UPDATE 原子执行。
export async function peekBalance(userId: number): Promise<number> {
  const pool = await getPool();
  if (!pool) return 0;
  try {
    const [rows] = await pool.query("SELECT points_balance FROM users WHERE id = ?", [userId]);
    return Number((rows as Record<string, unknown>[])[0]?.points_balance ?? 0);
  } catch {
    // 读失败一律放行（返回足够余额），不因探针故障阻断正常链路
    return Number.POSITIVE_INFINITY;
  }
}

// 在**调用方已开启的事务连接**上执行「加分 + 流水」，不自行 begin/commit/release。
// v17.4：给需要与其它写库动作同生共死的场景用（如签到：checkins 行与发墨必须同事务，
// 否则发墨失败后签到行已落库、用户当天既没墨也签不了）。抛错由调用方 catch → 整体回滚。
export async function creditPointsOn(
  conn: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  userId: number,
  amount: number,
  reason: string
): Promise<boolean> {
  const [upd] = (await conn.query(
    "UPDATE users SET points_balance = points_balance + ? WHERE id = ?",
    [amount, userId]
  )) as [{ affectedRows?: number }];
  if (Number(upd?.affectedRows ?? 0) !== 1) return false;
  await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
    userId,
    amount,
    reason,
  ]);
  return true;
}

// 退分（生成失败等场景）：事务 + 正向流水
export async function creditPoints(
  userId: number,
  amount: number,
  reason: string
): Promise<{ ok: boolean; balance?: number }> {
  const pool = await getPool();
  if (!pool) return { ok: false };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      "UPDATE users SET points_balance = points_balance + ? WHERE id = ?",
      [amount, userId]
    );
    if (Number((rows as { affectedRows?: number }).affectedRows ?? 0) === 0) {
      await conn.rollback();
      return { ok: false };
    }
    await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
      userId,
      amount,
      reason,
    ]);
    const [after] = await conn.query("SELECT points_balance FROM users WHERE id = ?", [userId]);
    await conn.commit();
    return { ok: true, balance: Number((after as Record<string, unknown>[])[0]?.points_balance ?? 0) };
  } catch {
    await conn.rollback();
    return { ok: false };
  } finally {
    conn.release();
  }
}

// 每日免费额度懒重置：用户当天首个请求触发（经济收紧后 30 点/日，主补给走充值）。
// 单条 UPDATE 原子判重（last_quota_date < 今天 才发），并发安全；判重与流水同事务。
export async function grantDailyQuota(
  userId: number,
  amount = 30
): Promise<{ granted: boolean; balance?: number }> {
  const pool = await getPool();
  if (!pool) return { granted: false };
  const today = localDateStr();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.query(
      `UPDATE users
         SET points_balance = points_balance + ?, last_quota_date = ?
       WHERE id = ? AND (last_quota_date IS NULL OR last_quota_date < ?)`,
      [amount, today, userId, today]
    );
    if (Number((res as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
      await conn.rollback();
      return { granted: false };
    }
    await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
      userId,
      amount,
      "每日免费额度",
    ]);
    const [after] = await conn.query("SELECT points_balance FROM users WHERE id = ?", [userId]);
    await conn.commit();
    return { granted: true, balance: Number((after as Record<string, unknown>[])[0]?.points_balance ?? 0) };
  } catch {
    await conn.rollback();
    return { granted: false };
  } finally {
    conn.release();
  }
}

export function localDateStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 带每日上限的行为奖励：先在 reward_counters 计数（唯一主键防并发竞态），
// 超上限拒绝并回退计数；未超限则同事务内加分 + 落流水。
export async function grantCappedReward(
  userId: number,
  amount: number,
  reason: string,
  capKey: string,
  dailyCap: number
): Promise<{ granted: boolean; capped?: boolean; balance?: number }> {
  const pool = await getPool();
  if (!pool) return { granted: false };
  const today = localDateStr();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 原子计数 +1
    await conn.query(
      `INSERT INTO reward_counters (user_id, cap_key, cnt_day, cnt) VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE cnt = cnt + 1`,
      [userId, capKey, today]
    );
    const [rows] = await conn.query(
      "SELECT cnt FROM reward_counters WHERE user_id = ? AND cap_key = ? AND cnt_day = ?",
      [userId, capKey, today]
    );
    const cnt = Number((rows as Record<string, unknown>[])[0]?.cnt ?? 0);
    if (cnt > dailyCap) {
      await conn.rollback(); // 回退计数
      return { granted: false, capped: true };
    }
    const [upd] = await conn.query(
      "UPDATE users SET points_balance = points_balance + ? WHERE id = ?",
      [amount, userId]
    );
    if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
      await conn.rollback();
      return { granted: false };
    }
    await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
      userId,
      amount,
      reason,
    ]);
    const [after] = await conn.query("SELECT points_balance FROM users WHERE id = ?", [userId]);
    await conn.commit();
    return {
      granted: true,
      balance: Number((after as Record<string, unknown>[])[0]?.points_balance ?? 0),
    };
  } catch {
    await conn.rollback();
    return { granted: false };
  } finally {
    conn.release();
  }
}
