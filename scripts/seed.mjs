// 向 MySQL 写入演示文章正文（需先执行 db/schema.sql）
// 用法：npm run seed
import { createPool } from "mysql2/promise";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
    if (m) env.url = m[1].trim();
  }
} catch { /* .env 不存在时提示 */ }
if (!env.url) {
  console.error("未找到 .env 或 DATABASE_URL。请复制 .env.example 为 .env 并填写 MySQL 连接。");
  process.exit(1);
}

const BODIES = {
  "shou-xie-promise": `Promise 是 JavaScript 异步世界的通行证，但大多数教程止步于「会用」。这篇文章我们从零手写一个符合 Promises/A+ 规范的实现，并在最后处理两个最容易被忽略的边界条件。

## 一、最小可用实现

先搭建骨架。核心在于三态流转的不可逆性：\`pending\` 只能走向 \`fulfilled\` 或 \`rejected\`，且一旦离开就不回头。

\`\`\`javascript
class MyPromise {
  constructor(executor) {
    this.state = "pending";
    this.value = undefined;
    this.callbacks = [];
    const resolve = (value) => {
      if (this.state !== "pending") return; // 不可逆
      this.state = "fulfilled";
      this.value = value;
      this.callbacks.forEach(cb => cb.onFulfilled(value));
    };
    executor(resolve, reject);
  }
}
\`\`\`

> 「异步编程的本质不是回调，而是把『未来才会确定的值』变成一等公民。」

## 二、then 的微任务语义

很多手写实现栽在这一步：\`then\` 的回调必须异步执行，即使 \`resolve\` 已经同步发生。这就是事件循环的边界条件之一——**thenable 的时序承诺**。

## 三、两个边界条件

- **循环 thenable**：当 \`then\` 返回自身引用时，规范要求抛出 \`TypeError\`，否则死循环。
- **then 的多次调用**：回调要按注册顺序依次执行，缓存队列不可去重。

完整的 200 行实现和 47 个测试用例放在文末仓库。读完别忘了问一问我的分身——它读过我过去两年写的每一篇异步相关文章。`,
  "wenfeng-dangan": `给模型微调一个「文风」，听起来像大厂才玩得起的游戏。实际上，一份精心蒸馏的 Prompt 档案，能做到八成效果，成本是零。

## 文风可以被结构化

从你过去的 20 篇文章里，可以提炼出：句长分布、口头禅、论证习惯（先立靶还是先给结论）、括号使用频率、案例偏好。这些构成一份 800 字左右的「文风档案」，塞进 system prompt。

## 为什么比微调便宜

微调解决的是「能力」问题，而文风是「偏好」问题。偏好用示例约束，能力才需要训练。别用大炮打蚊子。

（本篇为演示数据，正式版将接入真实创作流。）`,
  "pgvector-gou-yong": `技术选型最大的陷阱，是把「别人的规模」当成自己的规模。

当你的文章总量还不到一万篇，pgvector 一个 HNSW 索引就能把召回压到 95% 以上，查询耗时个位数毫秒。这时候引入一个独立的向量数据库，你买到的是：多一个要运维的有状态服务、多一份内存账单，以及团队里每一个新人都要重新学一遍的部署文档。

真正的分界线在哪里？我的答案是：**当过滤条件开始和向量检索深度耦合的时候。**

（本篇为演示数据，正式版将接入真实创作流。）`,
};

const pool = createPool(env.url);
for (const [slug, md] of Object.entries(BODIES)) {
  const [r] = await pool.query("UPDATE articles SET md_content = ? WHERE slug = ?", [md, slug]);
  console.log(r.affectedRows ? `✓ ${slug} 正文已写入` : `✗ ${slug} 未找到（先跑 db/schema.sql）`);
}
await pool.end();
