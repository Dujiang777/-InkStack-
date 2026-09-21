import Link from "next/link";
import UserMenu from "./UserMenu";
import ThemeToggle from "./ThemeToggle";
import NotifBell from "./NotifBell";
import NavTabs from "./NavTabs";
import ViewSwitch from "./ViewSwitch";
import MobileDock from "./MobileDock";
import { getCurrentUser, isStaff } from "@/lib/auth";

// 报头：报头题字 + 印章 + 编号导航（杂志刊头语言）
// 导航分级：书房仅登录用户可见，运营台仅管理员可见（服务端渲染期判定）
export default async function Masthead() {
  const user = await getCurrentUser();
  const isAdmin = isStaff(user?.role); // v17.1：admin 与 developer 均可见运营台入口
  return (
    <header className="masthead">
      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {Array.from({ length: 2 }).map((_, dup) => (
            <span key={dup}>
              AI 编辑部 · 今晨精选：RAG 落地一年后，该谈「引用率」而不是「准确率」 ✦ 分身一周年：日均接待 4.2 万次提问 ✦
              新功能「文章即应用」内测开放 ✦ 独立开发者扶持计划启动 ✦&nbsp;
            </span>
          ))}
        </div>
      </div>
      <div className="masthead-inner">
        <Link href="/" className="brand" aria-label="墨栈首页">
          <span className="seal" aria-hidden="true">墨栈</span>
          <span className="brand-text">
            墨栈<span className="lat">InkStack — AI Native Blog</span>
          </span>
        </Link>
        <div className="mast-right">
          <div className="mast-date">
            创刊号 · VOL.01
            <br />
            2026 年 9 月 9 日 · 星期三
          </div>
          <ThemeToggle />
          <ViewSwitch />
        </div>
      </div>
      <nav className="tabs" aria-label="站点导航">
        <NavTabs loggedIn={Boolean(user)} isAdmin={isAdmin} />
        <div className="nav-tools">
          <p className="nav-motto" aria-hidden="true">
            墨水经济 · AI 分身 · 共评社区
          </p>
          {/* 全站搜索：原生表单 GET，无 JS 也可用 */}
          <form className="nav-search" action="/search" method="GET" role="search">
            <input name="q" placeholder="搜文章…" aria-label="全站搜索" maxLength={60} />
            <button type="submit" aria-label="搜索">
              ⌕
            </button>
          </form>
          {/* 漫游记：随机读一篇，解乏彩蛋（显眼胶囊入口） */}
          <Link className="nav-wander" href="/random" title="漫游记 · 随机读一篇" aria-label="漫游记：随机读一篇文章">
            <span className="nw-dice" aria-hidden="true">
              ⚄
            </span>
            漫游记
          </Link>
          {user && <NotifBell />}
          <UserMenu />
        </div>
      </nav>
      {/* 手机版底部墨条：仅 body.m 时显示（CSS 控制） */}
      <MobileDock loggedIn={Boolean(user)} />
    </header>
  );
}
