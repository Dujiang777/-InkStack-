// GET /api/auth/me — 当前登录用户（未登录返回 { user: null }）
// 顺带触发每日免费额度懒重置：当天首个请求 +100 分（UPDATE 原子判重，幂等且并发安全）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { grantDailyQuota } from "@/lib/points";

export async function GET() {
  let user = await getCurrentUser();
  if (user) {
    const q = await grantDailyQuota(user.id);
    if (q.granted && typeof q.balance === "number") {
      user = { ...user, points: q.balance };
    }
  }
  return NextResponse.json({ user });
}
