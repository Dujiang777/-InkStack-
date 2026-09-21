---
title: "RAG 落地一年后，该谈「引用率」而不是「准确率」"
author: "陈屿"
date: "2026-08-27"
tags:
  - "AI"
  - "RAG"
source: "墨栈 InkStack"
url: "http://localhost:3100/article/rag-yin-yong-lu-bi-zhun-que-lu"
words: 294
reading_minutes: 1
---

# RAG 落地一年后，该谈「引用率」而不是「准确率」

> 陈屿 · 2026-08-27 · 约 1 分钟读完 · [原文链接](http://localhost:3100/article/rag-yin-yong-lu-bi-zhun-que-lu)

> 与其争论「准不准」，不如测量「引没引」。

## § 为什么不是准确率

准确率的评测需要标准答案，而知识库类产品的标准答案维护成本极高，且不同人判断不一。引用率不同——它是**机器可测的硬指标**：

```text
引用率 = 带有效原文锚点的回答数 / 总回答数
```

## § 引用率怎么提

1. 切片带元数据（章节、标题），检索结果天然可锚定
2. prompt 里强制「先引后答」，没有锚点就拒答
3. 低置信度时降级为「本文未涉及」，别硬编

## § 引用率带来的产品红利

引用可点击之后，答案变成了**入口**：读者顺着引用跳回原文段落，阅读深度反而上升。AI 没有抢走内容，把人送回了内容。

---

*本文导自 [墨栈 InkStack](http://localhost:3100) · 导出于 2026-09-11 · 原文：[RAG 落地一年后，该谈「引用率」而不是「准确率」](http://localhost:3100/article/rag-yin-yong-lu-bi-zhun-que-lu)*
