"use client";

// 打赏成功彩带：canvas 粒子（墨滴 + 纸屑）从屏幕中部喷发，播完自动消失
// 用法：{burst && <InkBurst onDone={() => setBurst(false)} />}
import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
  shape: "drop" | "strip";
  life: number;
  maxLife: number;
};

const COLORS = ["#b3412f", "#a8842c", "#33566b", "#6d5a3e", "#c96f4a", "#4a7a5e"];

export default function InkBurst({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const originX = w / 2;
    const originY = h * 0.42;
    const parts: Particle[] = [];
    const TOTAL = 90;
    for (let i = 0; i < TOTAL; i++) {
      const angle = Math.PI * (0.15 + 0.7 * Math.random()); // 向上扇形
      const speed = 6 + Math.random() * 9;
      const shape: Particle["shape"] = Math.random() < 0.45 ? "drop" : "strip";
      parts.push({
        x: originX + (Math.random() - 0.5) * 60,
        y: originY + (Math.random() - 0.5) * 30,
        vx: Math.cos(angle) * speed * (Math.random() < 0.5 ? -1 : 1) * 0.55,
        vy: -Math.sin(angle) * speed,
        size: shape === "drop" ? 3 + Math.random() * 5 : 3 + Math.random() * 4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.25,
        shape,
        life: 0,
        maxLife: 70 + Math.random() * 50,
      });
    }

    let raf = 0;
    let frame = 0;
    const drawDrop = (p: Particle) => {
      // 墨滴：圆 + 上尖
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.62, 0, Math.PI * 2);
      ctx.moveTo(p.x, p.y - p.size * 1.25);
      ctx.quadraticCurveTo(p.x + p.size * 0.5, p.y - p.size * 0.2, p.x, p.y);
      ctx.quadraticCurveTo(p.x - p.size * 0.5, p.y - p.size * 0.2, p.x, p.y - p.size * 1.25);
      ctx.fill();
    };
    const drawStrip = (p: Particle) => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size * 1.6, -p.size * 0.34, p.size * 3.2, p.size * 0.68);
      ctx.restore();
    };

    const tick = () => {
      frame++;
      ctx.clearRect(0, 0, w, h);
      let alive = 0;
      for (const p of parts) {
        if (p.life >= p.maxLife) continue;
        alive++;
        p.life++;
        p.vy += 0.18; // 重力
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        const fade = Math.max(0, 1 - p.life / p.maxLife);
        ctx.globalAlpha = fade;
        ctx.fillStyle = p.color;
        if (p.shape === "drop") drawDrop(p);
        else drawStrip(p);
      }
      ctx.globalAlpha = 1;
      if (alive > 0 && frame < 180) {
        raf = window.requestAnimationFrame(tick);
      } else {
        onDone();
      }
    };
    raf = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [onDone]);

  return (
    <canvas
      ref={ref}
      className="ink-burst"
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 999 }}
      aria-hidden="true"
    />
  );
}
