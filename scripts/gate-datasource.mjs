// 双轨对比类闸门的起跑前检查：确认"Node 那一侧"真的还在用 Node 的实现取数。
//
// 为什么要单独管这件事：P7d 把 DATA_VIA_JAVA 的默认从"关"翻成"配了 JAVA_BASE 就走 Java"，
// 于是闸门打的那个"Node 对岸"很可能已经悄悄变成 Java 取数——两栈对拍会退化成
// "拿 Java 比 Java"，满屏绿字却什么都没验证。这类假阳性比红灯危险，
// 所以每个跨栈闸门开跑前先读一次中间件报的 x-data-source，不对就直接停，不往下比。
const cache = new Map();
const MISSING = "(应答里没有 x-data-source)";
const UNREACHABLE = "连不上：";

/** 读某一站点自报的取数路径（node / java），读不到返回说明文字而不是抛异常。 */
export async function dataSourceOf(base) {
  if (cache.has(base)) return cache.get(base);
  let value = MISSING;
  // dev 实例刚改过 middleware 时，第一发可能落在"旧 middleware 已编译好、新的还没接上"的缝里，
  // 表现就是应答里没有这个头。只在这个哨兵值上重试两次，真读到 java/node 就一次定论——
  // 重试不能扩大到"读到 java 也再试一次"，那会把一个真的误配洗成绿。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/`, {
        headers: { "user-agent": "inkstack-gate" }, cache: "no-store",
      });
      value = res.headers.get("x-data-source") ?? MISSING;
      await res.text();
    } catch (down) {
      value = `${UNREACHABLE}${String(down.message).slice(0, 40)}`;
    }
    if (value === "node" || value === "java") break;
    await new Promise((r) => setTimeout(r, 400));
  }
  cache.set(base, value);
  return value;
}

/**
 * 要求某一站点的取数路径就是 expected，否则判死退出。
 * 两侧都要钉：page-parity 比的必须是"一条 Node 路、一条 Java 路"，
 * 只钉住 Node 那侧的话，对岸哪天悄悄退回 Node 它照样全绿。
 */
export function requireDataSource(base, actual, expected) {
  if (actual === expected) return;
  const how = expected === "node"
    ? "  参照实例请显式带 DATA_VIA_JAVA=0（P7d 之后不设就跟着 JAVA_BASE 走 Java）。"
    : "  对岸实例请带 DATA_VIA_JAVA='*'（或至少列出这一跑要验的函数名）。";
  console.error(
    `\n站点 ${base} 自报取数路径 "${actual}"，不是 ${expected}。\n` +
    "  两栈闸门比的是「同一份数据、两套实现」——两侧一旦走成同一条路，\n" +
    "  这一跑就是拿 Java 比 Java 或拿 Node 比 Node，全绿也不说明任何事。" + `\n${how}`
  );
  process.exit(1);
}

/** 只关心"Node 那侧还在用 Node"的闸门用这个。 */
export function requireNodeDataSource(base, actual) {
  requireDataSource(base, actual, "node");
}
