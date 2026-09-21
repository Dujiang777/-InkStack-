// 生成 Gitee OAuth 应用 Logo：截图 scripts/logo.html 的 #logo 元素为 512x512 PNG
// 用法：node scripts/logo-shot.mjs
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const WS_NM = "C:/Users/AMBITIOUS_YUAN/.workbuddy/binaries/node/workspace/node_modules";
const { chromium } = createRequire(path.join(WS_NM, "noop.js"))("playwright-core");

const CHROME_CANDIDATES = [
  path.join(process.env.USERPROFILE ?? "", ".agent-browser", "browsers", "chrome-153.0.8010.36", "chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
function pickChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  throw new Error("找不到可用的 Chrome/Edge");
}

const browser = await chromium.launch({
  executablePath: pickChrome(),
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-crashpad", "--no-first-run"],
});
const ctx = await browser.newContext({ viewport: { width: 560, height: 560 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(pathToFileURL(path.join(process.cwd(), "scripts", "logo.html")).toString());
const el = page.locator("#logo");
await el.screenshot({ path: "logo-gitee-512.png" });
await browser.close();
console.log("[logo] 已保存 logo-gitee-512.png");
