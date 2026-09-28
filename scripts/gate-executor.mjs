// 跨栈闸门的起跑前检查：确认"我打的那一侧"真的是那个执行者在答，而不是被代理到了对岸。
//
// 为什么要单独管这件事：闸门比的是"同一份数据、两套实现"。两侧一旦由同一个执行者应答，
// 这一跑就是拿 Java 比 Java（或拿 Node 比 Node），满屏绿字却不说明任何事——
// 这类假阳性比红灯危险。判据用 Java 自己打的 `x-backend: inkstack-java`：
// 它在任何由 Java 应答的应答上都有，经 Next 转发过去也在（BackendTagFilter 是全局过滤器），
// 所以"没有这个头"就是"Node 自己答的"，不需要额外约定。
//
// P7e′ 之前这里读的是中间件自报的 x-data-source（页面取数走哪条路）。那个头已经删掉了：
// 页面只剩 Java 一条路之后，它要么恒真、要么说的不再是"两条路里的哪一条"——
// 一个含义会变掉的信号比没有信号更坏。
const cache = new Map();
const UNREACHABLE = "连不上：";
/** 探针路径：两栈都有、开销小，且不命中时会由 Node 自己回 404（那正是"Node 应答"的证据）。 */
const PROBE = "/api/articles?limit=1";

/**
 * 某一站点这一发接口由谁应答：'node' / 'java' / 一段说明文字（连不上时）。
 * 只读一次不重试——x-backend 要么有要么没有，没有"还没编译好"的中间态。
 */
export async function executorOf(base) {
  if (cache.has(base)) return cache.get(base);
  let value;
  try {
    const res = await fetch(base + PROBE, {
      headers: { "user-agent": "inkstack-gate" }, cache: "no-store",
    });
    value = (res.headers.get("x-backend") ?? "") === "inkstack-java" ? "java" : "node";
    await res.text();
  } catch (down) {
    value = `${UNREACHABLE}${String(down.message).slice(0, 40)}`;
  }
  cache.set(base, value);
  return value;
}

/** 要求某一站点由 expected 那个执行者应答，否则判死退出。 */
export async function requireExecutor(base, expected) {
  const actual = await executorOf(base);
  if (actual === expected) return;
  const how = expected === "node"
    ? "  这一侧不该被切走：把 JAVA_ROUTES 里命中它的前缀去掉（或干脆不设 JAVA_BASE）再跑。"
    : "  这一侧该由 Java 应答：检查 JAVA_BASE 与 JAVA_ROUTES 是否命中，或直接打 Java 自己的端口。";
  console.error(
    `\n站点 ${base} 的接口由 "${actual}" 应答，不是 ${expected}。\n` +
    "  跨栈闸门比的是「同一份数据、两套实现」——两侧一旦是同一个执行者，\n" +
    "  这一跑全绿也不说明任何事。" + `\n${how}`
  );
  process.exit(1);
}

/** 只关心"Node 那一侧真的还是 Node 在答"的闸门用这个。 */
export const requireNodeExecutor = (base) => requireExecutor(base, "node");
/** 反向：要求这一侧由 Java 应答（切流验证用）。 */
export const requireJavaExecutor = (base) => requireExecutor(base, "java");

/**
 * 这一对端点背后是不是**两个不同的执行者**——给"不能判死、但也不能装绿"的判据用。
 *
 * 整前缀切流（`JAVA_ROUTES=/api`）之后 PARITY_NODE 其实也是 Java（经 rewrite 转发），
 * 此时"两栈各答了一半"这类**断言出处**的判据宾语已经不存在了。它不该判红——
 * 不是实现回归，是这一跑的范围变了；更不该继续判绿——那等于给一个没被验证过的
 * 并发姿势盖章。所以调用方拿它把这类判据显式降成 SKIP，其余判据照跑。
 *
 * 反过来讲：这一对探针也正是"跨栈差分到底还成不成立"的机器证据。P7f 删掉
 * Node 侧实现之后，全仓库只剩这里还会如实说"跨实现的那一半已经没法比了"。
 */
export async function isCrossStack(nodeBase, javaBase) {
  const [a, b] = [await executorOf(nodeBase), await executorOf(javaBase)];
  return a !== b && !a.startsWith(UNREACHABLE) && !b.startsWith(UNREACHABLE);
}
