// POST /api/articles/[slug]/paywall-view — 付费墙到达埋点
// 仅在读者真正被墙挡住时由 PaywallCard 挂载触发；匿名可用（漏斗需要游客数据）。
// v17.1 防刷：同一 IP 对同一篇文章 30 分钟内只计一次（漏斗是「到达人次」，重复挂载/脚本刷量不应放大）
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";
import { recordPaywallView } from "@/lib/data";
import { clientIp } from "@/lib/audit";

const DEDUP_WINDOW_MS = 30 * 60 * 1000;
const g = globalThis as typeof globalThis & { __inkPaywallSeen?: Map<string, number> };
const seen = (g.__inkPaywallSeen ??= new Map<string, number>());

/** 返回 true = 本次可计数；false = 窗口内已计过 */
function firstHit(key: string): boolean {
  const now = Date.now();
  const last = seen.get(key) ?? 0;
  if (now - last < DEDUP_WINDOW_MS) return false;
  seen.set(key, now);
  // 防 Map 无限膨胀：超过 20000 条时清掉过期项
  if (seen.size > 20_000) {
    for (const [k, t] of seen) if (now - t >= DEDUP_WINDOW_MS) seen.delete(k);
  }
  return true;
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!dbEnabled()) return NextResponse.json({ ok: false }, { status: 503 });
  const { slug } = await params;
  if (slug.length > 200) return NextResponse.json({ ok: false }, { status: 400 });
  if (!firstHit(`${clientIp(req)}:${slug}`)) {
    return NextResponse.json({ ok: true, deduped: true });
  }
  await recordPaywallView(slug);
  return NextResponse.json({ ok: true });
}
