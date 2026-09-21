"use client";

// 滚动 reveal：进入视口的元素淡入上移（渐进增强，SSR 无碍）
import { useEffect } from "react";

export default function Reveal() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(
      ".hero-main, .hero-side, .card-ink, .comments, .admin-stats, .studio-head"
    );
    els.forEach((el, i) => {
      el.classList.add("reveal");
      // 同组元素按序错开 60ms，形成杂志翻页式的节奏感
      el.style.transitionDelay = `${(i % 6) * 60}ms`;
    });
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
