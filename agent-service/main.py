# -*- coding: utf-8 -*-
"""
墨栈 InkStack · AgentScope 智能体服务

架构：Next.js (Node) --HTTP/NDJSON--> 本服务 (FastAPI + AgentScope) --> DeepSeek

三个端点：
  GET  /health                 健康检查（返回 agentscope 版本与 live 状态）
  POST /agent/ask              博主分身 ReActAgent：自主调用「文章检索」工具（RAG），NDJSON 流式
  POST /ai/write               AI 写作助手：续写/润色/起标题（文风档案注入 system prompt）

流协议（与 Next.js app/api/agent/ask 完全一致，每行一个 JSON）：
  {"type":"delta","text":"…"}     回答增量
  {"type":"cite","citation":"…"}  结束时的引用来源（可为 null）
  {"type":"error","message":"…"}  出错

RAG 说明（P0）：DeepSeek 无 embedding 接口，因此不引入向量服务；
检索工具直接查 MySQL ngram 全文索引（与 Next.js 的 lib/rag.ts 同一策略）。
ReActAgent 自主决定何时调用检索工具 —— 这是 AgentScope 的核心收益。
P1 升级：换 agentscope[rag] + DashScope text-embedding-v3 + Qdrant 向量召回。
"""
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import pymysql
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

import agentscope
from agentscope.agent import ReActAgent
from agentscope.formatter import OpenAIChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.model import OpenAIChatModel
from agentscope.tool import Toolkit, ToolResponse
from agentscope.message import TextBlock

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

DEEPSEEK_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_BASE = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").strip()
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip()
LIVE = bool(DEEPSEEK_KEY)

MYSQL_CONF = dict(
    host=os.getenv("MYSQL_HOST", "localhost"),
    port=int(os.getenv("MYSQL_PORT", "3306")),
    user=os.getenv("MYSQL_USER", "root"),
    password=os.getenv("MYSQL_PASSWORD", ""),
    database=os.getenv("MYSQL_DB", "inkstack"),
    charset="utf8mb4",
)


# ============ RAG 检索工具（注册给 ReActAgent，Agent 自主决定何时调用） ============
# 注意：AgentScope 1.x 要求工具返回 ToolResponse（含 TextBlock），不能返回裸字符串
def _tool_text(text: str) -> ToolResponse:
    return ToolResponse(content=[TextBlock(type="text", text=text)])


def search_blog_articles(question: str) -> ToolResponse:
    """在博主已发布的全部文章中检索与问题相关的段落（MySQL 全文检索）。

    当且仅当需要依据博主的文章内容回答时调用本工具。
    返回带来源标题的片段列表，回答时必须依据片段内容并注明来源。
    """
    try:
        conn = pymysql.connect(**MYSQL_CONF)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT title,
                              SUBSTRING(md_content, 1, 2000) AS md
                       FROM articles
                       WHERE status = 'published'
                         AND MATCH(title, md_content)
                             AGAINST(%s IN NATURAL LANGUAGE MODE)
                       LIMIT 3""",
                    (question,),
                )
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as e:  # 数据库不可用时如实告知 Agent，而不是编造
        return _tool_text(f"检索工具暂时不可用（{e}）。请不要编造依据，直接告知读者稍后再试。")

    if not rows:
        return _tool_text("知识库中没有检索到相关文章片段。请不要编造，明确告知读者答不准。")

    parts = []
    for title, md in rows:
        # 抽取与问题字符有重叠的段落，最多 2 段/篇
        paras = [re.sub(r"[#>*`\[\]\-]", "", p).strip()
                 for p in md.split("\n\n") if len(p.strip()) > 30]
        kw = re.sub(r"[？?！!，。、\s]", "", question)
        hit = [p for p in paras if any(ch in p for ch in kw)][:2] or paras[:1]
        for p in hit:
            parts.append(f"《{title}》：{p[:300]}")
    return _tool_text("\n\n".join(parts)) if parts else _tool_text("未检索到有效段落。请不要编造。")


def build_model() -> OpenAIChatModel:
    return OpenAIChatModel(
        model_name=DEEPSEEK_MODEL,
        api_key=DEEPSEEK_KEY,
        stream=True,
        client_args={"base_url": DEEPSEEK_BASE},
    )


def build_avatar_agent(author: str, tone: str) -> ReActAgent:
    """构建博主分身：文风档案式 system prompt + 检索工具。"""
    tone_desc = {"rigorous": "严谨、克制、重依据", "humorous": "幽默但不出戏", "concise": "极简、直给"}[tone]
    toolkit = Toolkit()
    toolkit.register_tool_function(search_blog_articles)
    sys_prompt = (
        f"你是博主「{author}」的 AI 数字分身，以他的口吻回答读者提问。语气：{tone_desc}。\n"
        "规则：\n"
        "1. 涉及博主文章内容的问题，先调用 search_blog_articles 检索，回答必须基于片段；\n"
        "2. 回答末尾用一行「依据：《文章标题》」标注来源；\n"
        "3. 检索不到依据时如实告知答不准，建议转达博主，绝不编造；\n"
        "4. 回答控制在 200 字内。\n"
        "最后，把完整回答作为最终消息返回。"
    )
    return ReActAgent(
        name=f"{author}的分身",
        sys_prompt=sys_prompt,
        model=build_model(),
        formatter=OpenAIChatFormatter(),
        memory=InMemoryMemory(),
        toolkit=toolkit,
    )


# ============ FastAPI ============
@asynccontextmanager
async def lifespan(app: FastAPI):
    if not LIVE:
        print("⚠ 未配置 DEEPSEEK_API_KEY，服务以 demo 模式运行（返回固定话术）")
    yield


app = FastAPI(title="InkStack Agent Service (AgentScope)", lifespan=lifespan)


class AskBody(BaseModel):
    question: str
    author: str = "博主"
    tone: str = "rigorous"


class WriteBody(BaseModel):
    mode: str  # continue | polish | title
    draft: str = ""
    author: str = "博主"


def ndjson_stream(gen):
    """把异步生成器包成 NDJSON StreamingResponse。"""
    async def inner():
        async for item in gen:
            yield (json.dumps(item, ensure_ascii=False) + "\n").encode("utf-8")
    return StreamingResponse(
        inner(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-transform"},
    )


async def _run_agent_stream(agent, question: str):
    """调用 AgentScope ReActAgent，把最终回答按 NDJSON 增量下发。"""
    from agentscope.message import Msg

    try:
        reply = await agent(Msg(name="reader", content=question, role="user"))
        text = reply.get_text_content() or ""
        # 提取回答中的「依据：《…》」作为引用来源
        m = re.search(r"依据[:：]\s*(《[^》]+》[^。\n]*)", text)
        citation = m.group(1).strip() if m else None
        body = text
        step = max(1, len(body) // 40)
        for i in range(0, len(body), step):
            yield {"type": "delta", "text": body[i:i + step]}
        yield {"type": "cite", "citation": citation}
    except Exception as e:
        yield {"type": "error", "message": f"智能体执行失败：{e}"}


@app.get("/health")
async def health():
    return {"ok": True, "agentscope": getattr(agentscope, "__version__", "unknown"), "live": LIVE}


@app.post("/agent/ask")
async def agent_ask(body: AskBody):
    if not body.question.strip():
        return JSONResponse({"error": "question 不能为空"}, status_code=400)

    if not LIVE:
        async def demo():
            yield {"type": "delta", "text": "智能体服务已连通，但尚未配置 DEEPSEEK_API_KEY。"}
            yield {"type": "delta", "text": "配置后此处将由 AgentScope ReActAgent 实时生成。"}
            yield {"type": "cite", "citation": None}
        return ndjson_stream(demo())

    agent = build_avatar_agent(body.author, body.tone)
    return ndjson_stream(_run_agent_stream(agent, body.question.strip()))


WRITE_PROMPTS = {
    "continue": "续写这段草稿（300 字内），延续作者的论证节奏与口吻，只输出续写内容：\n\n{draft}",
    "polish": "润色这段草稿：保留原意与观点，收紧节奏、删冗余，只输出润色后的文本：\n\n{draft}",
    "title": "为这段草稿起 5 个中文标题，每行一个，风格克制不标题党：\n\n{draft}",
}


@app.post("/ai/write")
async def ai_write(body: WriteBody):
    if body.mode not in WRITE_PROMPTS:
        return JSONResponse({"error": "mode 须为 continue | polish | title"}, status_code=400)
    if not LIVE:
        # 返回 503 让调用方（Next.js）落入模板兜底，而不是把占位文案当真生成
        return JSONResponse({"error": "未配置 DEEPSEEK_API_KEY"}, status_code=503)

    agent = ReActAgent(
        name="写作助手",
        sys_prompt=f"你是博主「{body.author}」的写作助手，延续其个人文风，输出干净、可直接使用。",
        model=build_model(),
        formatter=OpenAIChatFormatter(),
        memory=InMemoryMemory(),
    )
    try:
        from agentscope.message import Msg
        reply = await agent(
            Msg(name="user", content=WRITE_PROMPTS[body.mode].format(draft=body.draft[:3000]), role="user")
        )
        return JSONResponse({
            "label": {"continue": "续写", "polish": "润色", "title": "起标题"}[body.mode],
            "text": reply.get_text_content() or "",
            "aiGenerated": True,
        })
    except Exception as e:
        return JSONResponse({"error": f"生成失败：{e}"}, status_code=500)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("AGENT_SERVICE_PORT", "8100")))
