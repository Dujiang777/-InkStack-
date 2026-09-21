"use client";

// 阅读足迹上报：文章页挂载后静默记录一次（游客请求会被服务端忽略）
import { useEffect } from "react";

export default function ReadTracker({ slug }: { slug: string }) {
  useEffect(() => {
    const key = `rh:${slug}`;
    // 同一会话内同一篇只上报一次，避免刷新刷量
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
      keepalive: true,
    }).catch(() => {});
  }, [slug]);
  return null;
}
