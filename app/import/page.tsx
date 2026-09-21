import { getCurrentUser } from "@/lib/auth";
import ImportClient from "@/components/ImportClient";

export const metadata = { title: "迁移工坊 · 墨栈 InkStack" };

// 迁移工坊：旧博客 → 墨栈的一键搬家（P0 获客钩子）
// 登录后文章导入自己账号，分身全文索引即时生效
export default async function ImportPage() {
  const user = await getCurrentUser();

  return (
    <div className="import-page">
      <div className="import-head">
        <span className="kicker">MIGRATION DESK · 获客钩子</span>
        <h1>迁移工坊</h1>
        <p className="import-lede">
          把你在别处写的文章搬进墨栈。导入即发布，你的 AI 分身<b>立刻</b>能检索、引用这些内容——
          读者在文章页提问时，分身会答出你过去的观点。
        </p>
      </div>

      {user ? (
        <ImportClient />
      ) : (
        <div className="mig-login-hint">
          <p>先<a href="/login">登录</a>，文章才会导入到你自己的账号下。</p>
          <p className="sub">还没有账号？注册即送 100 滴墨水，导入文章不消耗墨水。</p>
        </div>
      )}

      <div className="import-steps">
        <div className="step">
          <span className="no">壹</span>
          <h3>搬文章</h3>
          <p>RSS 一键抓取最新 20 篇，或拖入整包 Markdown 文件。同名自动去重，不打乱你的存稿。</p>
        </div>
        <div className="step">
          <span className="no">贰</span>
          <h3>分身学习</h3>
          <p>入库即建全文索引，分身马上能检索引用。P1 升级向量检索后，理解会更细腻。</p>
        </div>
        <div className="step">
          <span className="no">叁</span>
          <h3>读者来问</h3>
          <p>读者读完文章直接问「分身的你」。它只依据你的文章回答，答不准会老实说。</p>
        </div>
      </div>
    </div>
  );
}
