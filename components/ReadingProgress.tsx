"use client";

// 顶部阅读进度条（文章页）
import { useEffect, useState } from "react";

export default function ReadingProgress() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const total = h.scrollHeight - h.clientHeight;
      setPct(total > 0 ? Math.min(100, (h.scrollTop / total) * 100) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <div className="reading-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-label="阅读进度">
      <div className="reading-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
