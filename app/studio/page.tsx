import Link from "next/link";
import StudioClient from "@/components/StudioClient";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";

// AI 创作台：稿纸编辑器 + AI 编辑部 + 发布台
// ?edit=slug 进入编辑模式（书房「编辑」入口跳转而来）
export default async function StudioPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  const user = dbEnabled() ? await getCurrentUser() : null;
  const points = user ? user.points : null;
  const editSlug = user ? (edit ?? null) : null;

  return (
    <div className="studio-page">
      <div className="section-head studio-head">
        <h2>{editSlug ? "创作台 · 编辑文章" : "创作台 · 草稿箱"}</h2>
        <span className="points">
          {user
            ? `墨水余额 ${points} · AI 续写 15 / 润色 10 / 起标题 5`
            : "游客模式 · 登录后草稿云同步、AI 助手可用"}
        </span>
      </div>
      {edit && !user && (
        <p className="admin-denied">
          登录后才能编辑文章。<Link href="/login">去登录 →</Link>
        </p>
      )}
      <StudioClient editSlug={editSlug} isAdmin={isStaff(user?.role)} />
    </div>
  );
}
