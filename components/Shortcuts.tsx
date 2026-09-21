"use client";

// 键盘快捷键彩蛋：/ 聚焦搜索 · R 漫游记 · T 夜读切换 · ? 帮助
// 输入框聚焦时自动忽略；帮助浮层 Esc 关闭
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const KEYS: { k: string; label: string }[] = [
  { k: "/", label: "聚焦全站搜索" },
  { k: "R", label: "漫游记 · 随机读一篇" },
  { k: "T", label: "切换日间 / 夜读" },
  { k: "?", label: "打开这份快捷键卡" },
];

export function applyTheme(night: boolean) {
  if (night) {
    document.body.dataset.theme = "night";
    localStorage.setItem("ink-theme", "night");
  } else {
    delete document.body.dataset.theme;
    localStorage.setItem("ink-theme", "day");
  }
  window.dispatchEvent(new CustomEvent("ink-theme-change", { detail: night }));
}

export default function Shortcuts() {
  const [help, setHelp] = useState(false);
  const router = useRouter();

  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        setHelp(false);
        return;
      }
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "/") {
        const input = document.querySelector<HTMLInputElement>(".nav-search input");
        if (input) {
          e.preventDefault();
          input.focus();
        }
      } else if (k === "r") {
        router.push("/random");
      } else if (k === "t") {
        applyTheme(document.body.dataset.theme !== "night");
      } else if (e.key === "?") {
        e.preventDefault();
        setHelp((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (!help) return null;
  return (
    <div className="kbd-help-mask" onClick={() => setHelp(false)} role="dialog" aria-label="键盘快捷键">
      <div className="kbd-help" onClick={(e) => e.stopPropagation()}>
        <span className="kicker">快捷键 · KEYBOARD</span>
        <b className="kbd-title">编辑部的键盘暗号</b>
        <ul>
          {KEYS.map((it) => (
            <li key={it.k}>
              <kbd>{it.k}</kbd>
              <span>{it.label}</span>
            </li>
          ))}
        </ul>
        <p className="kbd-note">在输入框打字时不会触发。按 Esc 关闭这张卡。</p>
      </div>
    </div>
  );
}
