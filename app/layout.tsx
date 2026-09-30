import type { Metadata } from "next";
import Masthead from "@/components/Masthead";
import Footer from "@/components/Footer";
import AgentDock from "@/components/AgentDock";
import Shortcuts from "@/components/Shortcuts";
import BackTop from "@/components/BackTop";
import "./globals.css";

// 根布局带着 Masthead，而 Masthead 每次渲染都要现取一次会话（no-store）——所以这个应用里
// 没有可以在构建期预渲染的页。`next dev` 不预渲染，缺这一行只有 `npm run build` 会炸，
// 且炸在第一个静态路由上（先是 /study，补完又是 Next 自己合成的 /_not-found）。
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "墨栈 InkStack · AI 原生博客平台",
  description: "博主有 AI 分身、读者能和文章对话、平台自己会运营的下一代博客平台。",
  alternates: {
    types: { "application/rss+xml": "/feed.xml" },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* 展示字：思源宋体 / Fraunces；正文：思源黑体。font-display: swap 保证首屏 */}
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,900&family=Noto+Serif+SC:wght@600;900&family=Noto+Sans+SC:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* 防闪烁：首帧渲染前应用夜读主题 + 手机版视图（比 useEffect 早，避免白天/宽版闪一下） */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("ink-theme")==="night")document.body.dataset.theme="night";var v=localStorage.getItem("ink-view");if(v==="m"||(!v&&window.matchMedia&&matchMedia("(max-width: 820px)").matches))document.body.classList.add("m")}catch(e){}`,
          }}
        />
        <Masthead />
        <main>{children}</main>
        <Footer />
        <AgentDock />
        <BackTop />
        <Shortcuts />
      </body>
    </html>
  );
}
