// 泄露密码检查（Have I Been Pwned k-匿名模型）：
// 只上传 SHA-1 前 5 位，服务端返回所有匹配前缀的哈希尾部，本地比对 —— 密码本身绝不离开本机
// 网络异常/超时一律降级放行（fail-open），不阻塞注册与改密主流程
import { createHash } from "node:crypto";

const CACHE = new Map<string, string>(); // prefix5 -> 响应文本（1 小时缓存，省流量）
const TTL_MS = 60 * 60 * 1000;

export async function pwnedCount(password: string): Promise<number> {
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    let body = CACHE.get(prefix);
    if (!body) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000); // 3s 超时，宁放行不卡注册
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        signal: ctrl.signal,
        headers: { "Add-Padding": "true" },
      });
      clearTimeout(timer);
      if (!res.ok) return -1;
      body = await res.text();
      CACHE.set(prefix, body);
    }
    for (const line of body.split("\n")) {
      const [suf, count] = line.trim().split(":");
      if (suf === suffix) return Number(count) || 0;
    }
    return 0;
  } catch {
    return -1; // 降级：未知状态放行
  }
}
