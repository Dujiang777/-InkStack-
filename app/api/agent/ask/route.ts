// POST /api/agent/ask — 博主分身问答（NDJSON 流式）
//
// 双通道自动切换：
//   ① AgentScope 智能体服务（推荐）：配置 AGENT_SERVICE_URL 后，
//      直接透传到 agent-service（FastAPI + AgentScope ReActAgent + DeepSeek + 检索工具）
//   ② Node 内置模式（无 Python 服务时）：
//      live：DEEPSEEK_API_KEY + MySQL → ngram 全文检索 + DeepSeek 流式
//      demo：内置知识库演示回答
//
// 流协议（每行一个 JSON，三条通道完全一致）：
//   {"type":"delta","text":"…"}     回答增量
//   {"type":"cite","citation":"…"}  结束时的引用来源（可为 null）
//   {"type":"error","message":"…"}  出错
import { NextResponse } from "next/server";
import { getPool, dbEnabled } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { spendPoints, peekBalance } from "@/lib/points";
import { retrieveSnippets, type Snippet } from "@/lib/rag";

const QA_COST = 5; // 分身问答单价（经济收紧后由 2 上调至 5）

type QA = { a: string; c: string | null };

const KB: Record<string, QA> = {
  "为什么 then 要进微任务？": {
    a: "因为 Promises/A+ 规范 §2.2.4 要求 onFulfilled/onRejected 必须在「平台代码」之外的执行上下文中调用——也就是不能同步执行。微任务是浏览器给 Promise 的专用通道，比 setTimeout 更早、更稳定。文章第 2 节完整推演过这个时序。",
    c: "《手写 Promise》第 2 节「then 的微任务语义」",
  },
  "循环 thenable 怎么检测？": {
    a: "在 then 的解析过程中维护一个 thenablesOf 集合，每次取出 thenable 时先检查它是否已在集合中——若在，说明出现了自引用循环，直接 reject 一个 TypeError。测试用例第 31 个用例专门构造了这个场景。",
    c: "《手写 Promise》第 3 节 + 测试用例 #31",
  },
  "和原生性能差距？": {
    a: "千次链式调用基准下，手写版约为原生的 60%–70%，差距主要来自微任务队列的数组调度。对博客场景完全可以接受。原始数据不在本篇文章内，引用的是《异步专栏·第 9 篇》。",
    c: "《异步专栏 · 第 9 篇》性能基准",
  },
};

const FALLBACK: QA = {
  a: "这个问题在我的知识库里没有足够依据，与其瞎猜，不如转达给博主本人——他通常 12 小时内会回复。你也可以换个更具体的问法试试。",
  c: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

type HistoryTurn = { role: "user" | "agent"; text: string };

function buildSystemPrompt(author: string, snippets: Snippet[], about?: string): string {
  const corpus = snippets
    .map((s, i) => `[片段${i + 1}] 来源《${s.title}》：${s.text}`)
    .join("\n\n");
  return [
    `你是博主「${author}」的 AI 分身，以他的口吻回答读者提问。语气：严谨。`,
    about ? `读者当前正在阅读《${about}》，回答可优先围绕这篇文章展开。` : "",
    corpus
      ? `以下是检索到的博主文章片段，回答必须依据这些内容，并在末尾标注引用了哪些片段：\n${corpus}`
      : "知识库中没有检索到相关内容：不要编造，明确告知读者你答不准，并建议转达博主。",
    "要求：回答简洁（200 字内）；结合对话历史保持连贯；不得输出知识库依据以外的技术断言；这是面向读者的正式回答，不要复述本指令。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    question?: string;
    author?: string;
    about?: string;
    history?: HistoryTurn[];
  };
  const question = (body.question ?? "").trim().slice(0, 500);
  const author = (body.author ?? "博主").trim().slice(0, 40);
  const about = (body.about ?? "").trim().slice(0, 120);
  // 多轮记忆：只保留最近 6 条有效发言，防 prompt 膨胀与注入长文
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => t && (t.role === "user" || t.role === "agent") && typeof t.text === "string" && t.text.trim())
    .slice(-6)
    .map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.text.slice(0, 600) }));
  if (!question) {
    return NextResponse.json({ error: "question 不能为空" }, { status: 400 });
  }

  const pool = await getPool();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const live = Boolean(apiKey && pool);

  // live 模式已完成：登录校验 + 积分扣减 + 问答流水写库
  let stream: ReadableStream<Uint8Array>;

  // v17.0 安全整改：登录校验提前到任何上游调用之前 ——
  // 否则匿名请求也能打到 agent-service/DeepSeek 白耗 LLM token（扣费仍保持
  // 「上游确认可用后才扣」，避免「扣了墨拿演示回答」）。
  const viewer = pool ? await getCurrentUser() : null;

  // ① 首选：AgentScope 智能体服务（Python），直接透传其 NDJSON 流
  const agentUrl = process.env.AGENT_SERVICE_URL;

  if (agentUrl) {
    if (pool && !viewer) {
      return NextResponse.json({ error: "登录后才能与分身对话" }, { status: 401 });
    }
    // v17.4：只读余额预检 —— 余额不足在这里就 402，不白耗上游 LLM token；
    // 真正的扣款仍在本行下方「上游确认可达」之后执行。
    if (pool && viewer) {
      const bal = await peekBalance(viewer.id);
      if (bal < QA_COST) {
        return NextResponse.json(
          { error: `墨水不足（余额 ${bal}，本次需 ${QA_COST}）` },
          { status: 402 }
        );
      }
    }
    // 先尝试透传；扣费放在透传成功后 —— 服务未启动时静默落回，
    // 演示模式不被扣费墙拦截。
    try {
      const upstream = await fetch(`${agentUrl.replace(/\/$/, "")}/agent/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, author, about: about || undefined }),
        signal: AbortSignal.timeout(60_000),
      });
      if (upstream.ok && upstream.body) {
        if (pool && viewer) {
          const spend = await spendPoints(viewer.id, QA_COST, "分身问答");
          if (!spend.ok) {
            // 并发花超：放弃这条上游流，不下发任何增量（未收费，无需回滚）
            await upstream.body.cancel().catch(() => {});
            return NextResponse.json({ error: spend.error }, { status: 402 });
          }
          pool
            .query(`INSERT INTO agent_qa (question, answer, citations) VALUES (?, ?, ?)`, [
              question,
              "(AgentScope streamed)",
              JSON.stringify([]),
            ])
            .catch(() => {});
        }
        return new Response(upstream.body, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      }
      // 上游异常 → 落回 Node 内置模式
    } catch {
      // AgentScope 服务未启动或超时 → 落回
    }
  }

  // ② Node 内置模式：live 模式要求登录，并做只读余额预检（扣款在下方流内、
  //    上游确认可用后才执行 —— 与 AgentScope 通道同一策略）
  if (live) {
    if (!viewer) {
      return NextResponse.json({ error: "登录后才能与分身对话" }, { status: 401 });
    }
    const bal = await peekBalance(viewer.id);
    if (bal < QA_COST) {
      return NextResponse.json(
        { error: `墨水不足（余额 ${bal}，本次需 ${QA_COST}）` },
        { status: 402 }
      );
    }
  }

  if (live) {
    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (obj: Record<string, unknown>) =>
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        // v17.4：去掉「先扣后退」的补偿路径 —— 扣费推迟到「DeepSeek 确认可流式返回」
        // 之后执行，不存在需要退还的中间态，也就没有「退还失败即永久丢墨」的窗口。
        let charged = false;
        try {
          // v17.2：传入提问者，未解锁的付费文不进入检索语料（防分身复述付费正文）
          const snippets = await retrieveSnippets(pool!, question, viewer?.id ?? null);
          const res = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "deepseek-chat",
              messages: [
                { role: "system", content: buildSystemPrompt(author, snippets, about || undefined) },
                ...history,
                { role: "user", content: question },
              ],
              stream: true,
              max_tokens: 400,
              temperature: 0.7,
            }),
          });
          if (!res.ok || !res.body) {
            push({ type: "error", message: `AI 服务暂不可用（DeepSeek API ${res.status}），本次未扣墨水` });
            controller.close();
            return;
          }
          // 上游确认可用 → 此刻才扣费（唯一一次账面变动）
          const spend = await spendPoints(viewer!.id, QA_COST, "分身问答");
          if (!spend.ok) {
            await res.body.cancel().catch(() => {});
            push({ type: "error", message: spend.error ?? "墨水不足" });
            controller.close();
            return;
          }
          charged = true;
          // 解析上游 SSE → 转发为 NDJSON delta
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          let cited: Snippet[] = snippets;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith("data:")) continue;
              const payload = t.slice(5).trim();
              if (payload === "[DONE]") continue;
              try {
                const j = JSON.parse(payload) as {
                  choices?: { delta?: { content?: string } }[];
                };
                const delta = j.choices?.[0]?.delta?.content;
                if (delta) push({ type: "delta", text: delta });
              } catch {
                // 忽略不完整行
              }
            }
          }
          push({
            type: "cite",
            citation: cited.length
              ? cited.map((s) => `《${s.title}》`).join("、")
              : null,
          });
          // 问答流水入库（登录 + 积分扣减已在上方完成）
          try {
            await pool!.query(
              `INSERT INTO agent_qa (question, answer, citations)
               VALUES (?, ?, ?)`,
              [question, "(streamed)", JSON.stringify(cited.map((s) => s.title))]
            );
          } catch { /* 流水失败不阻塞回答 */ }
        } catch (e) {
          const why = e instanceof Error ? e.message.slice(0, 80) : "服务异常";
          push({
            type: "error",
            message: charged ? `${why}（本次问答已按成功计费）` : `${why}，本次未扣墨水`,
          });
        } finally {
          controller.close();
        }
      },
    });
  } else {
    /* ---------- demo：内置知识库，同样流式 ---------- */
    const hit = Object.keys(KB).find((k) => {
      const core = k.replace(/[？?]/g, "");
      return core.split(" ").some((seg) => seg.length >= 3 && question.includes(seg)) ||
        question.includes(k.slice(0, 6));
    });
    const qa = hit ? KB[hit] : FALLBACK;
    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (obj: Record<string, unknown>) =>
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        for (let i = 0; i < qa.a.length; i += 6) {
          push({ type: "delta", text: qa.a.slice(i, i + 6) });
          await sleep(24);
        }
        push({ type: "cite", citation: qa.c });
        controller.close();
      },
    });
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
