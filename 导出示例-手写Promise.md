---
title: "手写 Promise：从零实现，到理解事件循环的边界条件"
author: "陈屿"
date: "2026-09-06"
tags: []
source: "墨栈 InkStack"
url: "http://localhost:3100/article/shou-xie-promise"
words: 750
reading_minutes: 2
---

# 手写 Promise：从零实现，到理解事件循环的边界条件

> 陈屿 · 2026-09-06 · 约 2 分钟读完 · [原文链接](http://localhost:3100/article/shou-xie-promise)

Promise 是 JavaScript 异步世界的通行证，但大多数教程止步于「会用」。这篇文章我们从零手写一个符合 Promises/A+ 规范的实现，并在最后处理两个最容易被忽略的边界条件。

## 一、最小可用实现

先搭建骨架。核心在于三态流转的不可逆性：`pending` 只能走向 `fulfilled` 或 `rejected`，且一旦离开就不回头。

```javascript
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
```

> 「异步编程的本质不是回调，而是把『未来才会确定的值』变成一等公民。」

## 二、then 的微任务语义

很多手写实现栽在这一步：`then` 的回调必须异步执行，即使 `resolve` 已经同步发生。这就是事件循环的边界条件之一——**thenable 的时序承诺**。

## 三、两个边界条件

- **循环 thenable**：当 `then` 返回自身引用时，规范要求抛出 `TypeError`，否则死循环。
- **then 的多次调用**：回调要按注册顺序依次执行，缓存队列不可去重。

完整的 200 行实现和 47 个测试用例放在文末仓库。读完别忘了问一问我的分身——它读过我过去两年写的每一篇异步相关文章。

---

*本文导自 [墨栈 InkStack](http://localhost:3100) · 导出于 2026-09-11 · 原文：[手写 Promise：从零实现，到理解事件循环的边界条件](http://localhost:3100/article/shou-xie-promise)*
