// 内置演示数据：MySQL 未配置或不可用时自动降级使用，保证平台开箱可访问
export type DemoArticle = {
  slug: string;
  title: string;
  author: string;
  authorAvatar: string;
  summary: string;
  coverLabel: string;
  tags: string[];
  readCount: number;
  commentCount: number;
  agentQaCount: number;
  publishedAt: string;
  md: string;
};

export const demoArticles: DemoArticle[] = [
  {
    slug: "shou-xie-promise",
    title: "手写 Promise：从零实现，到理解事件循环的边界条件",
    author: "陈屿",
    authorAvatar: "陈",
    summary: "从零手写一个符合 Promises/A+ 规范的实现，并处理两个最容易被忽略的边界条件。",
    coverLabel: "卷一",
    tags: ["JavaScript", "异步编程"],
    readCount: 12840,
    commentCount: 132,
    agentQaCount: 1284,
    publishedAt: "2026-09-06",
    md: `Promise 是 JavaScript 异步世界的通行证，但大多数教程止步于「会用」。这篇文章我们从零手写一个符合 Promises/A+ 规范的实现，并在最后处理两个最容易被忽略的边界条件。

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
  },
  {
    slug: "wenfeng-dangan",
    title: "给每个博主训练一个「文风档案」，比微调模型便宜一百倍",
    author: "林晚",
    authorAvatar: "林",
    summary: "文风不是玄学：它可以从 20 篇历史文章里蒸馏成一份结构化 Prompt 档案。",
    coverLabel: "卷二",
    tags: ["Agent 工程"],
    readCount: 4200,
    commentCount: 87,
    agentQaCount: 302,
    publishedAt: "2026-09-08",
    md: `给模型微调一个「文风」，听起来像大厂才玩得起的游戏。实际上，一份精心蒸馏的 Prompt 档案，能做到八成效果，成本是零。

## 文风可以被结构化

从你过去的 20 篇文章里，可以提炼出：句长分布、口头禅、论证习惯（先立靶还是先给结论）、括号使用频率、案例偏好。这些构成一份 800 字左右的「文风档案」，塞进 system prompt。

## 为什么比微调便宜

微调解决的是「能力」问题，而文风是「偏好」问题。偏好用示例约束，能力才需要训练。别用大炮打蚊子。

（本篇为演示数据，正式版将接入真实创作流。）`,
  },
  {
    slug: "pgvector-gou-yong",
    title: "pgvector 够用了：别急着上专用向量库",
    author: "陈屿",
    authorAvatar: "陈",
    summary: "技术选型最大的陷阱，是把「别人的规模」当成自己的规模。",
    coverLabel: "卷三",
    tags: ["架构", "RAG"],
    readCount: 3800,
    commentCount: 64,
    agentQaCount: 96,
    publishedAt: "2026-09-09",
    md: `技术选型最大的陷阱，是把「别人的规模」当成自己的规模。

当你的文章总量还不到一万篇，pgvector 一个 HNSW 索引就能把召回压到 95% 以上，查询耗时个位数毫秒。这时候引入一个独立的向量数据库，你买到的是：多一个要运维的有状态服务、多一份内存账单，以及团队里每一个新人都要重新学一遍的部署文档。

真正的分界线在哪里？我的答案是：**当过滤条件开始和向量检索深度耦合的时候。**

（本篇为演示数据，正式版将接入真实创作流。）`,
  },
];

// 演示评论（按 slug 分组）
export type DemoComment = { id: number; nickname: string; content: string; createdAt: string };

export const demoComments: Record<string, DemoComment[]> = {
  "shou-xie-promise": [
    { id: 1, nickname: "苏打饼干", content: "第 3 节的循环 thenable 我踩过，当时调试了一整晚。收藏了。", createdAt: "2026-09-07 10:24" },
    { id: 2, nickname: "夜航西飞", content: "问过分身一个规范里没写的细节，它老实说答不准并转达了博主——这个体验比强行编一个答案好太多。", createdAt: "2026-09-07 21:02" },
    { id: 3, nickname: "老张", content: "47 个测试用例在哪？文末仓库链接没看到。", createdAt: "2026-09-08 09:15" },
  ],
  "wenfeng-dangan": [
    { id: 1, nickname: "纸飞机", content: "「偏好用示例约束，能力才需要训练」这句可以直接当座右铭。", createdAt: "2026-09-08 14:40" },
  ],
  "pgvector-gou-yong": [
    { id: 1, nickname: "阿柯", content: "EXPLAIN ANALYZE 判据很实用，试了下我们的库 Filter 占比 62%，确实该上混合检索了。", createdAt: "2026-09-09 11:08" },
  ],
};
