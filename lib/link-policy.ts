// 外链判定策略：白名单域名直接放行，其余在页面上标成"需审核"。
// P7f-2 起这一层**只剩判定**：默认白名单（代码/文档/社区站）+ 问 Java 要库里 approved 的那批。
// "提交审核"那条写路径（原来是本文件里一句 INSERT INTO link_whitelist）随 app/api/links 一起删了，
// 现在由 Java 的 `POST /api/links` 应答——渲染层不留任何写库的退路。
import { javaReady, remoteAllowedDomains } from "./java-source";

const DEFAULT_ALLOW = [
  "github.com", "gitee.com", "stackoverflow.com", "npmjs.com", "pypi.org",
  "developer.mozilla.org", "nodejs.org", "python.org", "react.dev", "nextjs.org",
  "mysql.com", "agentscope.io", "deepseek.com", "juejin.cn", "csdn.net",
  "zhihu.com", "segmentfault.com", "ruanyifeng.com", "v2ex.com",
];

export function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 当前全部放行域名 = 内置默认清单 ∪ 库里 approved 的那批。
 *
 * 库里的这一半从 Java 问（P7f-1f-b）：原来这条是本进程一句 `pool.query`，而它被 `lib/render.ts`
 * 在每次渲染文章时调用，属于"读者看不见却每个页面都要过一遍"的取数。
 * 默认清单留在 Next 侧——它是展示层的默认审美（哪些代码站天生可信），不是库里的数据。
 *
 * 失败口径与 Node 那版**故意不同**：Node 是 `catch` 之后静默用默认清单，于是"审核队列里已放行的
 * 域名"会悄悄变回不可点，页面上只表现为"链接又灰了"，没有任何地方说明这是取数挂了。
 * 现在按 `lib/java-source.ts` 文件头那条硬规矩——抛出，由页面 500 说清楚。
 * 60 秒的进程内缓存留在 `lib/render.ts`，一次渲染最多问一遍。
 */
export async function allowedDomains(): Promise<Set<string>> {
  const set = new Set(DEFAULT_ALLOW);
  if (!javaReady()) return set;   // 演示模式：只有默认清单，与 Node "拿不到池子" 那一支一字同
  for (const d of await remoteAllowedDomains()) set.add(String(d).toLowerCase());
  return set;
}
