// 探针：读取登录页关键元素的计算样式
import path from "node:path";
import { createRequire } from "node:module";
const WS_NM = "C:/Users/AMBITIOUS_YUAN/.workbuddy/binaries/node/workspace/node_modules";
const { chromium } = createRequire(path.join(WS_NM, "noop.js"))("playwright-core");
const exe = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
await page.goto("http://localhost:3100/login", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
const probe = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor + " / " + s.backgroundImage.slice(0, 90), z: s.zIndex, radius: s.borderRadius };
  };
  return {
    card: pick(".login-card"),
    shell: pick(".login-shell"),
    page: pick(".login-page"),
    spot: pick(".login-spot"),
    spotSize: (() => { const el = document.querySelector(".login-spot"); if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return `${Math.round(r.width)}x${Math.round(r.height)} bg=${s.backgroundImage.slice(0, 80)} z=${s.zIndex}`; })(),
  };
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
