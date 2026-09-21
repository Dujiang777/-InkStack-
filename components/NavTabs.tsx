"use client";

// 导航标签：usePathname 高亮当前页（server 端无法感知路径，抽成 client 子组件）
import Link from "next/link";
import { usePathname } from "next/navigation";

const NO = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾", "拾壹"];

export default function NavTabs({ loggedIn, isAdmin }: { loggedIn: boolean; isAdmin: boolean }) {
  const path = usePathname();
  const items: { href: string; label: string }[] = [
    { href: "/", label: "首页" },
    { href: "/article", label: "文章 × 分身" },
    { href: "/hot", label: "热榜" },
    { href: "/archive", label: "归档" },
    { href: "/series", label: "专栏" },
    { href: "/studio", label: "AI 创作台" },
  ];
  if (loggedIn) items.push({ href: "/study", label: "我的书房" });
  items.push({ href: "/import", label: "迁移工坊" });
  if (loggedIn) items.push({ href: "/me", label: "个人中心" }, { href: "/points", label: "墨仓" });
  if (isAdmin) items.push({ href: "/admin", label: "运营台" });

  const active = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(href + "/") || path.startsWith(href + "?");

  return (
    <>
      {items.map((it, i) => (
        <Link key={it.href} href={it.href} className={"tab" + (active(it.href) ? " on" : "")}>
          <span className="no">{NO[i] ?? "·"}</span>
          {it.label}
        </Link>
      ))}
    </>
  );
}
