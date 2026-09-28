// 「页面取数走不走 Java」这一判据单独成文件。
//
// 为什么不让 middleware.ts 直接 import lib/java-source.ts：那个模块顶部引了 react 的 cache
// 与 next/headers 的 cookies，拉进边缘运行时是一个不必要的耦合面；而这一判据本身只看两个
// 环境变量，纯函数，两边都该读同一份实现——否则中间件报出来的数据来源与页面实际走的取数
// 路径可能不是同一件事，那比没有这个头更糟。
const OFF = new Set(["0", "off", "false", "none"]);

/**
 * 三种写法：
 *   `DATA_VIA_JAVA=*`    全部已移植的函数都走 Java
 *   `DATA_VIA_JAVA=a,b`  只让列出的函数走 Java（逐函数灰度）
 *   `DATA_VIA_JAVA=0`    一律走 Node（回滚开关，也是"只跑 Next"的开发者的开关）
 * 没设这个变量时，**配了 `JAVA_BASE` 就算启用**。
 *
 * 默认值从"关"翻成"配了就开"是因为反过来的失败方式静默：漏设 DATA_VIA_JAVA 时页面照常渲染、
 * 看起来一切正常，而 Java 的读路径一行没被走过，真切上去那天才第一次见光。
 * 代价是 JAVA_BASE 配了而 Java 没起来时页面 500 而不是退回 Node——这是有意的，
 * 静默回落会把"后端挂了"伪装成"站点正常"。
 */
export function javaDataSource(fn?: string): boolean {
  const raw = (process.env.DATA_VIA_JAVA ?? "").trim();
  if (OFF.has(raw.toLowerCase())) return false;
  if (!raw) return !!process.env.JAVA_BASE?.trim();
  if (raw === "*") return true;
  // 逐函数灰度：只问"整体开没开"时，列表非空就算开
  return fn ? raw.split(",").map((s) => s.trim()).filter(Boolean).includes(fn) : true;
}
