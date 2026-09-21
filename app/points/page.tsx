import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { grantDailyQuota, localDateStr } from "@/lib/points";
import TopUpClient from "@/components/TopUpClient";

export const metadata = { title: "墨仓 · 墨水账户 · 墨栈 InkStack" };
export const dynamic = "force-dynamic";

// 墨仓（/points）：墨水账户 + 充值 + 明细。
// 规则一览（经济收紧版：获取降档，主补给走充值）：
//   获得：注册 100 · 每日访问 30（懒重置）· 签到周期 10/20/40（7 天一轮后重置）
//         发布 +20（≤1 篇/日）· 评论 +1（≤3 条/日）· 文章被评论 +2（≤10 条/日）
//   消耗：AI 写作分档（续写 15 / 润色 10 / 起标题 5 / 选题 5）· 分身问答 5/次
//   充值：¥6/¥18/¥50/¥128 四档，买越多单价越划算（演示支付通道）
function cycleDayOf(streak: number): number {
  return ((streak - 1) % 7) + 1;
}
function rewardForCycleDay(cd: number): number {
  if (cd >= 7) return 40;
  if (cd >= 3) return 20;
  return 10;
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

export default async function PointsPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="points-page">
        <div className="points-head">
          <span className="kicker">INK DEPOT · 墨水账户</span>
          <h1>墨仓</h1>
          <p className="points-lede">墨水是你在墨栈的通货：写作用它，问分身用它。</p>
        </div>
        <div className="mig-login-hint">
          <p>先<a href="/login">登录</a>查看你的墨仓。</p>
          <p className="sub">还没有账号？注册即送 100 滴墨水。</p>
        </div>

        <div className="points-grid">
          <div className="p-stat">
            <span className="p-label">新人礼</span>
            <b className="p-ok">+100</b>
            <span className="p-sub">注册即送，无需充值</span>
          </div>
          <div className="p-stat">
            <span className="p-label">每日补给</span>
            <b>+30</b>
            <span className="p-sub">每天访问自动入仓，签到还能加码</span>
          </div>
          <div className="p-stat">
            <span className="p-label">作者分成</span>
            <b>70%</b>
            <span className="p-sub">文章被解锁 / 被打赏，作者大头拿走</span>
          </div>
        </div>

        <div className="rules-grid">
          <div className="rule-card">
            <h3>墨从何来 · 获得</h3>
            <ul>
              <li><b>+100</b> 注册赠送</li>
              <li><b>+30</b> 每日访问自动补给</li>
              <li><b>+10/20/40</b> 每日签到：7 天一周期，收官日 +40</li>
              <li><b>+20</b> 发布文章（每日上限 1 篇，防灌水）</li>
              <li><b>+1</b> 发表评论（每日上限 3 条）</li>
              <li><b>充值</b> 四档套餐，买越多单价越划算</li>
            </ul>
          </div>
          <div className="rule-card">
            <h3>墨往何处去 · 消耗</h3>
            <ul>
              <li><b>−15</b> AI 续写（最重的生成任务）</li>
              <li><b>−10</b> AI 润色</li>
              <li><b>−5</b> AI 起标题 / 推荐选题</li>
              <li><b>−5</b> 分身问答（读者向你的 AI 分身提问）</li>
              <li className="rule-note">生成失败自动退墨，不扣冤枉墨水。</li>
            </ul>
          </div>
        </div>

        <footer className="points-foot">
          <div className="hf-note">
            <b>还没入墨？</b>
            <p>
              注册即送 100 滴，每天访问再自动补 30 滴——足够先把 AI 续写和分身问答试个遍。
              真到了日更的强度，再回这里按需补给。
            </p>
          </div>
          <div className="hf-acts">
            <Link className="hf-cta" href="/login">
              <i aria-hidden="true">墨</i>
              <span className="hf-body">
                <b>注册领 100 滴</b>
                <small>每日再补 30 滴</small>
              </span>
            </Link>
            <Link className="hf-cta" href="/search">
              <i aria-hidden="true">检</i>
              <span className="hf-body">
                <b>全站检索</b>
                <small>先看看别人的文章</small>
              </span>
            </Link>
            <Link className="hf-cta" href="/hot">
              <i aria-hidden="true">榜</i>
              <span className="hf-body">
                <b>热度热榜</b>
                <small>本周最值得读的</small>
              </span>
            </Link>
          </div>
        </footer>
      </div>
    );
  }

  // 懒重置：访问本页视作当天活跃，自动补发每日 30（幂等）
  await grantDailyQuota(user.id);

  const pool = await getPool();
  let balance = user.points;
  let quotaDone = false;
  let streak = 0;
  let ledger: { delta: number; reason: string; at: string }[] = [];

  if (pool) {
    try {
      const [uRows] = await pool.query(
        "SELECT points_balance, last_quota_date FROM users WHERE id = ? LIMIT 1",
        [user.id]
      );
      const u = (uRows as Record<string, unknown>[])[0];
      if (u) {
        balance = Number(u.points_balance);
        quotaDone = dayKey(u.last_quota_date) === localDateStr();
      }
      const [cRows] = await pool.query(
        `SELECT checkin_date FROM checkins
          WHERE user_id = ? AND checkin_date >= CURDATE() - INTERVAL 60 DAY
          ORDER BY checkin_date DESC`,
        [user.id]
      );
      const set = new Set((cRows as { checkin_date: unknown }[]).map((r) => dayKey(r.checkin_date)));
      const cursor = new Date();
      if (!set.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
      while (set.has(dayKey(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
      const [lRows] = await pool.query(
        `SELECT delta, reason, DATE_FORMAT(created_at, '%m-%d %H:%i') AS at
           FROM point_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
        [user.id]
      );
      ledger = (lRows as Record<string, unknown>[]).map((r) => ({
        delta: Number(r.delta),
        reason: String(r.reason),
        at: String(r.at),
      }));
    } catch {
      /* 查询失败时展示兜底值 */
    }
  }

  const cd = cycleDayOf(streak);
  const curReward = rewardForCycleDay(cd);
  const nextCd = cycleDayOf(streak + 1);
  const nextReward = rewardForCycleDay(nextCd);
  const quotaText = quotaDone ? "今日 30 滴已入仓" : "今日 30 滴待领取（访问任意页自动入仓）";
  const ledgerSum = ledger.reduce((s, r) => s + r.delta, 0);

  return (
    <div className="points-page">
      <div className="points-head">
        <span className="kicker">INK DEPOT · 墨水账户</span>
        <h1>墨仓</h1>
        <p className="points-lede">
          墨水是你在墨栈的通货：AI 写作、分身问答、打赏加热都从这里取。
          每日补给只够日常小酌，<b>高产作者请按需入墨</b>。
        </p>
      </div>

      <div className="points-grid">
        <div className="p-stat p-main">
          <span className="p-label">当前余额</span>
          <b className="p-balance">{balance}</b>
          <span className="p-sub">滴墨水</span>
        </div>
        <div className="p-stat">
          <span className="p-label">每日补给</span>
          <b className={quotaDone ? "p-ok" : "p-wait"}>{quotaDone ? "已入仓" : "待领取"}</b>
          <span className="p-sub">{quotaText}</span>
        </div>
        <div className="p-stat">
          <span className="p-label">签到周期</span>
          <b>第 {cd} / 7 天</b>
          <span className="p-sub">
            已连签 {streak} 天 · 本周期当日档 +{curReward} ·{" "}
            {nextCd === 1 ? "下次签到开启新一轮 +10" : `下次签到 +${nextReward}`}
          </span>
        </div>
      </div>

      <section className="topup-section">
        <header className="topup-head">
          <span className="kicker">TOP UP · 补给站</span>
          <h3 className="section-title">墨水补给站</h3>
          <p className="topup-lede">
            四档套餐一次入仓、永久有效。做大额创作前先备墨，AI 续写与分身问答就不会断顿。
            买得越足，每元换回的墨水越多——下面每一档都标了换算刻痕。
          </p>
        </header>
        <TopUpClient />
      </section>

      <div className="rules-grid">
        <div className="rule-card">
          <h3>墨从何来 · 获得</h3>
          <ul>
            <li><b>+100</b> 注册赠送</li>
            <li><b>+30</b> 每日访问自动补给</li>
            <li><b>+10/20/40</b> 每日签到：7 天一周期，第 1-2 天 +10、第 3-6 天 +20、第 7 天收官 +40，第 8 天起新周期重置</li>
            <li><b>+20</b> 发布文章（每日上限 1 篇，防灌水）</li>
            <li><b>+1</b> 发表评论（每日上限 3 条）</li>
            <li><b>+2</b> 文章被读者评论（作者奖励，每日上限 10 条）</li>
            <li><b>充值</b> 四档套餐，买越多单价越划算（下方补给站）</li>
          </ul>
        </div>
        <div className="rule-card">
          <h3>墨往何处去 · 消耗</h3>
          <ul>
            <li><b>−15</b> AI 续写（最重的生成任务）</li>
            <li><b>−10</b> AI 润色</li>
            <li><b>−5</b> AI 起标题 / 推荐选题</li>
            <li><b>−5</b> 分身问答（读者向你的 AI 分身提问）</li>
            <li className="rule-note">生成失败自动退墨，不扣冤枉墨水。</li>
          </ul>
        </div>
      </div>

      <div className="ledger">
        <header className="ledger-head">
          <h3>墨水账本</h3>
          <span className="ledger-recent">最近 20 笔 · 出入皆记</span>
        </header>
        {ledger.length ? (
          <>
            <ol className="ledger-list">
              {ledger.map((r, i) => (
                <li key={i} className={`ld-row ${r.delta >= 0 ? "up" : "down"}`}>
                  <span className="ld-mark" aria-hidden="true">
                    {r.delta >= 0 ? "入" : "出"}
                  </span>
                  <span className="ld-amount">{r.delta >= 0 ? `+${r.delta}` : r.delta}</span>
                  <span className="ld-reason">{r.reason}</span>
                  <span className="ld-at">{r.at}</span>
                </li>
              ))}
            </ol>
            <p className="ledger-foot">
              近 20 笔合计{" "}
              <b>{ledgerSum >= 0 ? `+${ledgerSum.toLocaleString()}` : ledgerSum.toLocaleString()}</b>{" "}
              滴 · 每日补给、签到与充值都会自动记在这里
            </p>
          </>
        ) : (
          <div className="ledger-empty">
            <span className="le-seal" aria-hidden="true">
              空
            </span>
            <b>账本还是空的</b>
            <p>还没有一笔流水——去写点什么，或者今天先签个到，第一笔很快就来。</p>
            <Link className="le-cta" href="/studio">
              上版写作
            </Link>
          </div>
        )}
      </div>

      <footer className="points-foot">
        <div className="hf-note">
          <b>墨水的去处</b>
          <p>
            写作用它，问分身用它，给作者打赏、替文章加热也用它。AI 生成失败会自动退墨，不扣冤枉墨水；
            每日补给（+30）只够日常小酌，签到周期与编辑器一样按自然日结算。
          </p>
        </div>
        <div className="hf-acts">
          <Link className="hf-cta" href="/studio">
            <i aria-hidden="true">写</i>
            <span className="hf-body">
              <b>AI 创作台</b>
              <small>续写 / 润色 / 起标题</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/hot">
            <i aria-hidden="true">榜</i>
            <span className="hf-body">
              <b>热度热榜</b>
              <small>看哪种墨水最值钱</small>
            </span>
          </Link>
          <Link className="hf-cta" href="/search">
            <i aria-hidden="true">检</i>
            <span className="hf-body">
              <b>全站检索</b>
              <small>按题名 / 摘要定位</small>
            </span>
          </Link>
        </div>
      </footer>
    </div>
  );
}
