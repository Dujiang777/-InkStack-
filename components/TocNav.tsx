"use client";

// 本文目录（交互版）：滚动监听高亮当前章节，点击平滑滚动
// 替换原静态 toc-card；无标题时不渲染
import { useEffect, useState } from "react";
import type { TocItem } from "@/lib/render";

export default function TocNav({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    if (items.length === 0) return;
    const heads = items
      .map((t) => document.getElementById(t.id))
      .filter((el): el is HTMLElement => el !== null);
    if (heads.length === 0) return;

    // 滚动方向感知：取视口上部 1/3 处最近的标题
    let ticking = false;
    const pick = () => {
      ticking = false;
      const line = window.innerHeight * 0.33;
      let cur = heads[0]?.id ?? "";
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= line) cur = h.id;
        else break;
      }
      // 滚到底部时强制点亮最后一节
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 24) {
        cur = heads[heads.length - 1].id;
      }
      setActive(cur);
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(pick);
      }
    };
    pick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav className="toc-card toc-live" aria-label="本文目录">
      <b className="toc-head">本文目录</b>
      <ul>
        {items.map((t) => (
          <li key={t.id} className={`lv-${t.level}${active === t.id ? " on" : ""}`}>
            <a
              href={`#${t.id}`}
              aria-current={active === t.id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(t.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                history.replaceState(null, "", `#${t.id}`);
              }}
            >
              {t.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
