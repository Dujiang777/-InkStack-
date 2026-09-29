// 跨栈闸门的执行者探针：确认"我打的那一侧"到底是谁在答，而不是被代理到了对岸。
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
//
// P7f-2 之后这里只剩探针本身。原先配套的 requireExecutor / requireNodeExecutor /
// requireJavaExecutor（"这一侧必须真是 Node，否则拒绝起跑"）跟着闸门 1（parity）与
// 闸门 2（interop）一起退役了——Node 侧不再应答任何 /api，"必须是 Node 在答"这个前提
// 永远不成立，于是一道永远拒绝起跑的闸门等于被删掉，不如直接删掉。
const cache = new Map();
const UNREACHABLE = "连不上：";
/** 探针路径：开销小，且历史上不命中时会由 Node 自己回 404（那正是"Node 应答"的证据）。 */
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

/**
 * 这一对端点背后是不是**两个不同的执行者**——给"不能判死、但也不能装绿"的判据用。
 *
 * P7f-2 之后它恒为 false（Node 侧已经没有 /api 实现，两个端口都是 Java），而这正是它的用途：
 * 调用方拿它把"两栈各答了一半""并发确实来自两个进程"这类**只在对岸存在时才有意义**的判据
 * 显式降成 SKIP，其余绝对判据照跑。反过来讲，它仍然是全仓库唯一还会如实说出
 * "跨实现的那一半已经没法比了"的地方——一道失去宾语的判据在这里不装绿，也不判红。
 */
export async function isCrossStack(nodeBase, javaBase) {
  const [a, b] = [await executorOf(nodeBase), await executorOf(javaBase)];
  return a !== b && !a.startsWith(UNREACHABLE) && !b.startsWith(UNREACHABLE);
}
