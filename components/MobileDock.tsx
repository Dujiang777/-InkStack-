"use client";

// 手机版底部「墨条」拇指导航：仅 body.m（手机版）时显示，桌面隐藏
// 五枚墨印：首页 / 热榜 / 搜索 / 漫游 / 我的（未登录换登录）
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function MobileDock({ loggedIn }: { loggedIn: boolean }) {
  const path = usePathname();
  const items = [
    { href: "/", label: "首页", ico: "首" },
    { href: "/hot", label: "热榜", ico: "热" },
    { href: "/search", label: "搜索", ico: "搜" },
    { href: "/random", label: "漫游", ico: "游" },
    loggedIn
      ? { href: "/me", label: "我的", ico: "我" }
      : { href: "/login", label: "登录", ico: "登" },
  ];
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="mdock" aria-label="手机版导航">
      {items.map((it) => (
        <Link key={it.href} href={it.href} className={"mdock-item" + (active(it.href) ? " on" : "")}>
          <i className="md-ico" aria-hidden="true">{it.ico}</i>
          <span>{it.label}</span>
        </Link>
      ))}
    </nav>
  );
}
