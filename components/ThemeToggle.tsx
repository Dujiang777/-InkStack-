"use client";

// 夜读模式切换：暖纸 ↔ 深墨。localStorage 记忆，body[data-theme] 驱动 CSS 变量
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [night, setNight] = useState(false);

  useEffect(() => {
    setNight(localStorage.getItem("ink-theme") === "night");
  }, []);

  function toggle() {
    const next = !night;
    setNight(next);
    if (next) {
      document.body.dataset.theme = "night";
      localStorage.setItem("ink-theme", "night");
    } else {
      delete document.body.dataset.theme;
      localStorage.setItem("ink-theme", "day");
    }
  }

  // 首帧应用（防闪烁在 layout 里做了内联脚本则更好，P0 客户端切换即可）
  useEffect(() => {
    if (night) document.body.dataset.theme = "night";
  }, []);

  // 快捷键（T）等其他入口切换主题时，保持按钮状态同步
  useEffect(() => {
    const onExternal = (e: Event) => {
      const next = Boolean((e as CustomEvent).detail);
      setNight(next);
    };
    window.addEventListener("ink-theme-change", onExternal);
    return () => window.removeEventListener("ink-theme-change", onExternal);
  }, []);

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      title={night ? "切回日间暖纸" : "切换夜读深墨"}
      aria-label="切换夜读模式"
      aria-pressed={night}
    >
      {night ? "☀" : "☾"}
    </button>
  );
}
