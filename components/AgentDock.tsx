"use client";

// AgentDock —— 全站分身浮窗
// · 右下角墨滴 FAB，任何页面、任何滚动位置永远可达（position: fixed）
// · 文章页桌面端自动隐藏（侧栏 sticky 分身已覆盖，避免双入口）
// · 移动端/窄视口：底部抽屉式浮窗，分身不再"压轴"也不消失
// · 打开时自动感知正在读的文章标题，作为分身的阅读上下文
import { usePathname } from "next/navigation";
import { useState } from "react";
import AgentChat from "./AgentChat";

const SITE_PERSONA = { author: "墨栈", qa: 1024 };

export default function AgentDock() {
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState<string | undefined>(undefined);
  const pathname = usePathname();
  const onArticle = Boolean(pathname?.startsWith("/article/"));

  function toggle() {
    if (!open) {
      // 打开瞬间感知阅读上下文：文章页取标题，其他页为全站分身
      const t = onArticle ? document.querySelector(".article-title")?.textContent?.trim() : undefined;
      setAbout(t || undefined);
    }
    setOpen((v) => !v);
  }

  return (
    <div className="agent-dock">
      {open && (
        <div className="agent-dock-panel" role="dialog" aria-label="分身浮窗">
          <button className="agent-dock-close" onClick={toggle} aria-label="收起分身">
            ×
          </button>
          <AgentChat author={SITE_PERSONA.author} agentQaCount={SITE_PERSONA.qa} about={about} />
        </div>
      )}
      <button className="agent-fab" onClick={toggle} aria-label={open ? "收起分身" : "唤起分身"} aria-expanded={open}>
        <svg className="fab-drop" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path
            d="M12 2.6c3.6 4.9 6.6 8.6 6.6 12.1A6.6 6.6 0 0 1 12 21.3a6.6 6.6 0 0 1-6.6-6.6c0-3.5 3-7.2 6.6-12.1Z"
            fill="currentColor"
            opacity="0.95"
          />
          <circle cx="9.6" cy="13.4" r="1.5" fill="rgba(255,255,255,0.55)" />
        </svg>
        <span className="fab-label" aria-hidden="true">
          问分身
        </span>
        <i className="fab-ring" aria-hidden="true" />
      </button>
    </div>
  );
}
