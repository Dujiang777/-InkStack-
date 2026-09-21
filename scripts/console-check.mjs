// 抓 /login 页控制台错误与页面异常（查 Next dev overlay 的 Issue）
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const WS_NM = "C:/Users/AMBITIOUS_YUAN/.workbuddy/binaries/node/workspace/node_modules";
const { chromium } = createRequire(path.join(WS_NM, "noop.js"))("playwright-core");
const CHROME = [
  path.join(process.env.USERPROFILE ?? "", ".agent-browser", "browsers", "chrome-153.0.8010.36", "chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => p && existsSync(p));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await (await browser.newContext()).newPage();
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.goto("http://127.0.0.1:3100/login", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log(logs.length ? logs.join("\n---\n") : "(no console errors/warnings)");
await browser.close();
