import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { javaReady, remoteMeProfile } from "@/lib/java-source";
import { followStats, listMyFollowing, listMyFollowers, listMyLikes, listMyComments, listMyBookmarks, listMyHistory, listAchievements, badgeRewardClaimed } from "@/lib/data";
import MeClient from "@/components/MeClient";

export const metadata = { title: "个人中心 · 墨栈 InkStack" };
export const dynamic = "force-dynamic";

// 个人中心（/me）：账号资料 / 安全 / 墨水资产 / 关注与足迹。
// 与「我的书房 /study」（作品管理）分工：书房管作品，这里管账号与关系。
export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // 账号资料那五个字段原本是一句写在本文件里的 pool.query。默认值现在由 Java 负责
  // （印文留空回退昵称首字、注册日缺省 "—"），因为那条回退规则与 PATCH /api/me/profile
  // 写库用的是同一条——两处分叉的表现是"保存后预览对的，刷新就变了"。
  const profile = javaReady() ? await remoteMeProfile() : null;
  const bio = profile?.bio ?? "";
  const createdAt = profile?.createdAt ?? "—";
  const avatarText = profile?.avatarText || user.nickname.slice(0, 1);
  const avatarTone = profile?.avatarTone ?? "";
  const avatarShape = profile?.avatarShape ?? "";

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
