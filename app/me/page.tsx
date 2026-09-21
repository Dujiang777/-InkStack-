import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { followStats, listMyFollowing, listMyFollowers, listMyLikes, listMyComments, listMyBookmarks, listMyHistory, listAchievements, badgeRewardClaimed, ensureAvatarColumns } from "@/lib/data";
import MeClient from "@/components/MeClient";

export const metadata = { title: "个人中心 · 墨栈 InkStack" };
export const dynamic = "force-dynamic";

// 个人中心（/me）：账号资料 / 安全 / 墨水资产 / 关注与足迹。
// 与「我的书房 /study」（作品管理）分工：书房管作品，这里管账号与关系。
export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const pool = await getPool();
  let bio = "";
  let createdAt = "—";
  let avatarText = user.nickname.slice(0, 1);
  let avatarTone = "";
  let avatarShape = "";
  if (pool) {
    try {
      await ensureAvatarColumns(pool);
      const [rows] = await pool.query(
        `SELECT IFNULL(bio, '') AS bio, avatar_text AS avatarText,
                COALESCE(avatar_tone, '') AS avatarTone, COALESCE(avatar_shape, '') AS avatarShape,
                DATE_FORMAT(created_at, '%Y-%m-%d') AS createdAt
         FROM users WHERE id = ? LIMIT 1`,
        [user.id]
      );
      const r = (rows as Record<string, unknown>[])[0];
      if (r) {
        bio = String(r.bio ?? "");
        createdAt = String(r.createdAt ?? "—");
        avatarText = String(r.avatarText ?? avatarText) || avatarText;
        avatarTone = String(r.avatarTone ?? "");
        avatarShape = String(r.avatarShape ?? "");
      }
    } catch {
      /* 兜底 */
    }
  }

  const [stats, following, followers, likes, comments, bookmarks, reads, achievements, rewardClaimed] = await Promise.all([
    followStats(user.id),
    listMyFollowing(user.id),
    listMyFollowers(user.id),
    listMyLikes(user.id),
    listMyComments(user.id),
    listMyBookmarks(user.id),
    listMyHistory(user.id),
    listAchievements(user.id),
    badgeRewardClaimed(user.id),
  ]);

  return (
    <MeClient
      me={{
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        avatarText,
        avatarTone,
        avatarShape,
        role: user.role,
        points: user.points,
      }}
      bio={bio}
      createdAt={createdAt}
      stats={stats}
      following={following}
      followers={followers}
      likes={likes}
      comments={comments}
      bookmarks={bookmarks}
      history={reads}
      achievements={achievements}
      rewardClaimed={rewardClaimed}
    />
  );
}
