# AgentScope 智能体服务集成方案 v0.1

> 决策：智能体框架采用 **AgentScope**（阿里通义实验室开源，Apache 2.0，Python 3.10+）。
> 本文档说明选型理由、集成架构与各智能体的职责边界。

## 一、为什么选 AgentScope

| 维度 | AgentScope | 备选（LangGraph / CrewAI / 自研） |
|---|---|---|
| 核心抽象 | Agent 是一等公民，`ReActAgent` 内置「思考→调用工具→观察」循环 | LangGraph 以图编排为主，CrewAI 偏角色扮演 |
| 模型接入 | `OpenAIChatModel` 兼容 DeepSeek/vLLM 等 OpenAI 系 API；`DashScopeChatModel` 接通义 | 各家都有，AgentScope 对 DashScope 生态最深 |
| 异步 | 全异步架构，天然适配 FastAPI + SSE/NDJSON 流式 | LangGraph 异步支持较好 |
| 运行时 | `agentscope-runtime` 可一键把 Agent 部署成生产级 FastAPI 服务（健康检查/会话管理/A2A 协议） | 需自建 |
| 版本 | 1.x 稳定线（2026-03 v1.0.18+），2.0 线已带原生 RAG/流式增强 | — |

**对本项目的关键收益**：分身 Agent 的核心行为——「读者提问 → 判断要不要查博主文章 → 调检索工具 → 依据片段回答并标注来源 → 查不到就承认答不准」——用 ReActAgent + 一个自定义工具即可表达，无需手写编排逻辑。

## 二、集成架构

```
浏览器
  │ fetch NDJSON
  ▼
Next.js app/api/agent/ask/route.ts        ← 登录校验 + 积分扣减（Node 侧统一收口）
  │ 配置了 AGENT_SERVICE_URL → 透传
  ▼
agent-service (Python 3.10+ · FastAPI · AgentScope)
  ├─ /agent/ask   分身 ReActAgent
  │    ├─ 模型：OpenAIChatModel → DeepSeek（deepseek-chat，OpenAI 兼容接口）
  │    ├─ 工具：search_blog_articles（MySQL ngram 全文检索，Agent 自主调用）
  │    └─ 记忆：InMemoryMemory（按请求新建，P1 换 Redis 跨会话记忆）
  ├─ /ai/write    写作助手（续写/润色/起标题，文风档案注入 system prompt）
  └─ /health      健康检查
  ▼
MySQL（articles 全文索引） + DeepSeek API
```

**职责边界（重要）**：
- 鉴权、积分、问答流水、内容合规：全部留在 **Next.js（Node）侧**，Python 服务保持无状态、不做权限
- 智能体行为（工具调用、提示词、文风档案、引用来源）：全部在 **agent-service** 侧
- 两边用同一 NDJSON 协议（delta/cite/error），前端 `AgentChat.tsx` 无感知

## 三、RAG 策略演进

| 阶段 | 方案 | 说明 |
|---|---|---|
| P0（当前） | MySQL ngram 全文检索，注册为 ReActAgent 的工具 | DeepSeek 无 embedding 接口，零新增基础设施 |
| P1 | DashScope text-embedding-v3 + Qdrant 向量召回，混合检索 | 换 `agentscope[rag]`，工具签名不变 |
| P2 | 查询改写 + Reranker（bge-reranker）+ 多知识库路由 | 按博主分库，Agent 自动路由 |

## 四、运行方式

```bash
cd inkstack/agent-service
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
copy .env.example .env          # 填 DEEPSEEK_API_KEY 和 MySQL 密码
python main.py                  # http://127.0.0.1:8100
```

Next.js 侧：`.env` 里加 `AGENT_SERVICE_URL=http://127.0.0.1:8100`，分身问答自动切到智能体服务；服务没启动时自动回落 Node 内置模式（前端无感知）。

## 五、后续 Agent 规划（对应产品草案的四个智能体）

| Agent | 现状 | 规划 |
|---|---|---|
| 分身 Agent | ✅ 本服务 /agent/ask | 复核回写、禁答清单、A2A 跨博主召唤 |
| 写作 Agent | ✅ /ai/write（单轮） | 选题 Agent + 文风档案 LoRA 化 |
| 问答 Agent（文章即应用） | 复用分身，限定单篇文章 scope | 闪卡/思维导图结构化输出 |
| 运营 Agent | 未建 | AI 编辑部：专题策划 + 沉睡旧文激活（定时任务 + AgentScope 多 Agent 协作） |
