"use client";

// 手机版 / 电脑版切换章：
// - 默认跟随设备：视口 ≤ 820px 自动进入手机版（body.m）
// - 手动切换后记忆到 localStorage("ink-view")，优先于自动判定
// - 手机版视觉 = body.m 前缀样式层（globals.css v16），桌面也能一键预览
import { useEffect, useState } from "react";

const MQ = "(max-width: 820px)";

export default function ViewSwitch() {
  const [mobile, setMobile] = useState<boolean | null>(null); // null = 跟随设备
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(MQ);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    try {
      const saved = localStorage.getItem("ink-view");
      if (saved === "m") setMobile(true);
      else if (saved === "pc") setMobile(false);
    } catch {}
    return () => mq.removeEventListener("change", sync);
  }, []);

  const on = mobile === null ? narrow : mobile;

  useEffect(() => {
    document.body.classList.toggle("m", on);
  }, [on]);

  // 按钮文案 = 点击后切到什么（在手机版显示「电脑版」，反之亦然）
  return (
    <button
      className="view-switch"
      onClick={() => {
        const next = !on;
        setMobile(next);
        try {
          localStorage.setItem("ink-view", next ? "m" : "pc");
        } catch {}
      }}
      title="切换手机版 / 电脑版视图"
      aria-label="切换手机版或电脑版视图"
    >
      <span className="vs-ico" aria-hidden="true">{on ? "▤" : "▣"}</span>
      {on ? "电脑版" : "手机版"}
    </button>
  );
}
