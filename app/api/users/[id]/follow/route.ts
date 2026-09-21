// POST /api/users/[id]/follow — 关注/取关 toggle（登录限定；防自关；被关注发通知）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { toggleFollow, followStats } from "@/lib/data";
import { notify } from "@/lib/notify";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { id } = await params;
  const targetId = Number(id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  const result = await toggleFollow(user.id, targetId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "不能关注自己" ? 400 : 500 });
  }

  // 关注成功 → 通知被关注者（取关不发，避免打扰）
  if (result.following) {
    const pool = await getPool();
    if (pool) {
      try {
        const [rows] = await pool.query(`SELECT nickname FROM users WHERE id = ? LIMIT 1`, [targetId]);
        const t = (rows as { nickname?: string }[])[0];
        if (t) {
          notify(targetId, "system", "有新读者关注了你", `${user.nickname} 成为了你的读者`, "/me");
        }
      } catch {
        /* 通知失败静默 */
      }
    }
  }

  const stats = await followStats(targetId);
  // 注意顺序：following 是布尔状态，必须放在 stats 之后防被同名计数覆盖
  return NextResponse.json({ ok: true, ...stats, following: Boolean(result.following) });
}
