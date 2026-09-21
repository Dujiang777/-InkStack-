"use client";

// 文章页增强：代码块「复制」按钮 + 图片灯箱 + 阅读字号偏好（三档记忆）
import { useEffect } from "react";

const FS_KEY = "ink-article-font";
// 杂志正文三档：≈15.7 / 17.3 / 19.5px（基于 16px root），替代初版过大的 1.6-1.95rem
const SIZES: Record<string, string> = { s: "0.98rem", m: "1.08rem", l: "1.22rem" };

export default function ArticleEnhance() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    // ---------- 阅读字号偏好：正文右上角小工具，三档记忆 ----------
    const main = document.querySelector<HTMLElement>(".article-main");
    if (main) {
      const dock = document.createElement("div");
      dock.className = "font-dock";
      dock.setAttribute("role", "group");
      dock.setAttribute("aria-label", "阅读字号");
      dock.innerHTML = [
        '<button data-fs="s" title="小字号">A−</button>',
        '<button data-fs="m" title="标准字号">A</button>',
        '<button data-fs="l" title="大字号">A+</button>',
      ].join("");
      const body = main.querySelector<HTMLElement>(".article-body");

      const apply = (k: string) => {
        if (body) body.style.fontSize = SIZES[k] ?? SIZES.m;
        dock.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-fs") === k));
      };
      const saved = localStorage.getItem(FS_KEY) ?? "m";
      apply(saved);
      const onClickDock = (e: Event) => {
        const t = (e.target as HTMLElement).closest("button");
        if (!t) return;
        const k = t.getAttribute("data-fs") ?? "m";
        localStorage.setItem(FS_KEY, k);
        apply(k);
      };
      dock.addEventListener("click", onClickDock);
      main.appendChild(dock);
      cleanups.push(() => dock.remove());
    }

    // ---------- 代码块复制按钮 ----------
    document.querySelectorAll<HTMLElement>(".code-block").forEach((fig) => {
      const win = fig.querySelector(".code-win");
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "复制";
      const onClick = () => {
        const code = fig.querySelector("code")?.textContent ?? "";
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = "已复制 ✓";
          setTimeout(() => (btn.textContent = "复制"), 1200);
        });
      };
      btn.addEventListener("click", onClick);
      win?.appendChild(btn);
      cleanups.push(() => btn.removeEventListener("click", onClick));
    });

    // ---------- 图片点击放大（简易灯箱） ----------
    const overlay = document.createElement("div");
    overlay.className = "lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.innerHTML = '<img alt="" />';
    const overlayImg = overlay.querySelector("img") as HTMLImageElement;
    const close = () => overlay.classList.remove("open");
    overlay.addEventListener("click", close);
    const escKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", escKey);

    document.querySelectorAll<HTMLImageElement>(".article-figure img").forEach((img) => {
      const onClick = () => {
        overlayImg.src = img.src;
        overlay.classList.add("open");
      };
      img.addEventListener("click", onClick);
      cleanups.push(() => img.removeEventListener("click", onClick));
    });
    document.body.appendChild(overlay);
    cleanups.push(() => {
      overlay.remove();
      document.removeEventListener("keydown", escKey);
    });

    return () => cleanups.forEach((fn) => fn());
  }, []);
  return null;
}
