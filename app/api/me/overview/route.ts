// GET /api/me/overview — 个人中心足迹聚合：关注列表/我点赞的/我评论的（登录限定）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listMyFollowing, listMyLikes, listMyComments, followStats } from "@/lib/data";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const [following, likes, comments, stats] = await Promise.all([
    listMyFollowing(user.id),
    listMyLikes(user.id),
    listMyComments(user.id),
    followStats(user.id),
  ]);

  return NextResponse.json({
    ok: true,
    following,
    likes,
    comments,
    stats,
  });
}
