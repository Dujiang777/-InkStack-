// /api/checkin — 每日签到积分补给（商业闭环「积分从哪来」的常规来源）
// GET  → { checkedInToday, streak, cycleDay, balance, reward(下次签到实得), next(下一档进度) }
// POST → 签到：checkins 唯一主键 (user_id, checkin_date) 天然防重放（并发也安全）。
//
// 【7 天周期档位】连续天数照实累计（荣誉展示），奖励按「本周期第 N 天」计算：
//   cycleDay = ((连签数 - 1) % 7) + 1
//   第 1-2 天 +10，第 3-6 天 +20，第 7 天收官 +40；第 8 天起新周期重置回 +10。
//   → 经济收紧：每轮 10,10,20,20,20,20,40 = 140 点，主补给走充值。
//
// v17.4：签到行与发墨收进**同一事务**。原实现是「INSERT checkins → creditPoints」两段式，
//   发墨失败时靠一条额外的 DELETE 补偿；一旦该 DELETE 自身也失败（DB 抖动/重启发生在
//   两条语句之间），签到行留下、墨没到账，用户当天既拿不到奖励也签不了到（唯一键占位），
//   且未捕获的异常会直接冒成 500。现在任一步失败即整体回滚，用户可原样重试。
// 自然日按服务器本地时区。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool, dbEnabled } from "@/lib/db";
import { creditPointsOn } from "@/lib/points";

const CYCLE_DAYS = 7;

function cycleDayOf(streak: number): number {
  return ((streak - 1) % CYCLE_DAYS) + 1;
}

function rewardForCycleDay(cycleDay: number): number {
  if (cycleDay >= CYCLE_DAYS) return 40;
  if (cycleDay >= 3) return 20;
  return 10;
}

// 以「下一次签到后的周期天数」为基准，算升档还差几天；null = 下次即收官/最高
function nextTier(streak: number): { days: number; reward: number } | null {
  const cd = cycleDayOf(streak + 1);
  if (cd >= CYCLE_DAYS) return null; // 下次签到就是第 7 天收官
  if (cd >= 3) return { days: CYCLE_DAYS - cd, reward: 40 };
  return { days: 3 - cd, reward: 20 };
}

function dayKey(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v ?? "").slice(0, 10);
}

function todayKey(): string {
  return dayKey(new Date());
}

type Pool = NonNullable<Awaited<ReturnType<typeof getPool>>>;

// 连续签到天数：今天已签则从今天往回数，否则从昨天往回数
async function calcStreak(pool: Pool, userId: number): Promise<number> {
  const [rows] = await pool.query(
    "SELECT checkin_date FROM checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 400",
    [userId]
  );
  const set = new Set(
    (rows as { checkin_date: unknown }[]).map((r) => dayKey(r.checkin_date))
  );
  const cursor = new Date();
  if (!set.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (set.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

async function statusPayload(userId: number) {
  const pool = await getPool();
  if (!pool) return null;
  const [today] = await pool.query(
    "SELECT 1 FROM checkins WHERE user_id = ? AND checkin_date = ? LIMIT 1",
    [userId, todayKey()]
  );
  const checkedInToday = Array.isArray(today) && today.length > 0;
  const streak = await calcStreak(pool, userId);
  const cycleDay = cycleDayOf(streak);
  // reward 语义统一为「下次签到实得」：无论今天是否已签，下次签到后连签数 = streak + 1
  const reward = rewardForCycleDay(cycleDayOf(streak + 1));
  return { checkedInToday, streak, cycleDay, reward, next: nextTier(streak) };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "签到需要 MySQL" }, { status: 503 });
  const s = await statusPayload(user.id);
  if (!s) return NextResponse.json({ error: "数据库暂不可用" }, { status: 503 });
  return NextResponse.json({ ...s, balance: user.points });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能签到" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "签到需要 MySQL" }, { status: 503 });
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库暂不可用" }, { status: 503 });

  // 连签数在插入今天这行之前算 → 即「昨天为止的连签数」，今天签完 = 该值 + 1
  // （与旧实现「先插入再 calcStreak」得到的数字完全一致，奖励档位不变）
  const streakBefore = await calcStreak(pool, user.id);
  const streakAfter = streakBefore + 1;
  const cycleDay = cycleDayOf(streakAfter);
  const reward = rewardForCycleDay(cycleDay);

  const conn = await pool.getConnection();
  let balance = user.points;
  try {
    await conn.beginTransaction();
    try {
      await conn.query("INSERT INTO checkins (user_id, checkin_date) VALUES (?, ?)", [
        user.id,
        todayKey(),
      ]);
    } catch (e) {
      await conn.rollback();
      if ((e as { code?: string }).code === "ER_DUP_ENTRY") {
        // 今天已签（含并发双击的败者）：唯一键拦下，不产生任何变更
        const s = await statusPayload(user.id);
        return NextResponse.json({ ok: false, already: true, balance: user.points, ...s });
      }
      return NextResponse.json({ error: "签到失败，请稍后再试" }, { status: 500 });
    }
    // 发墨与签到行同事务：发不出去就整体回滚，用户可重试
    const okCredit = await creditPointsOn(
      conn,
      user.id,
      reward,
      `每日签到·周期第${cycleDay}天`
    );
    if (!okCredit) {
      await conn.rollback();
      return NextResponse.json({ error: "墨水发放失败，请重试" }, { status: 500 });
    }
    const [after] = await conn.query("SELECT points_balance FROM users WHERE id = ?", [user.id]);
    balance = Number((after as Record<string, unknown>[])[0]?.points_balance ?? 0);
    await conn.commit();
  } catch {
    await conn.rollback().catch(() => {});
    return NextResponse.json({ error: "签到失败，请稍后再试" }, { status: 500 });
  } finally {
    conn.release();
  }

  return NextResponse.json({
    ok: true,
    reward,
    balance,
    streak: streakAfter,
    cycleDay,
    checkedInToday: true,
    next: nextTier(streakAfter),
  });
}
