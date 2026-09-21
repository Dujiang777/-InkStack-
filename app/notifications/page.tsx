import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import NotifList from "@/components/NotifList";

// 通知中心：评论 / 打赏 / 点赞 / 审核结果 / 系统消息
export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="notif-page">
        <div className="section-head">
          <h2>通知中心</h2>
        </div>
        <p className="admin-denied">
          登录后查看通知。<Link href="/login">去登录 →</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="notif-page">
      <div className="section-head notif-head">
        <div>
          <span className="kicker">INBOX · 通知中心</span>
          <h2>你的信箱</h2>
          <p className="notif-sub">评论、点赞、打赏、审核结果与系统消息都在这里；点击任意一条即可跳转并标记已读。</p>
        </div>
        <span className="admin-flag">@{user.nickname}</span>
      </div>
      <NotifList />
    </div>
  );
}
