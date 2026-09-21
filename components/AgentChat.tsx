"use client";

// 分身问答 v3 —— 墨栈全站记忆点
// · 多轮对话：携带最近 6 轮 history，分身有记忆
// · 阅读上下文：about 告诉分身读者正在读哪篇文章
// · 会话工具：清空重来、复制回答
// · 401/402 优雅提示（余额不足/未登录直接给行动指引）
// 版式：墨色渐变描边、印章头像、气泡左右分、墨滴打字动画
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "agent"; text: string; cite?: string | null };

const SUGGESTIONS = ["用一句话概括这篇文章", "这篇文章最容易被误解的点？", "接下来我该读什么？"];

/** 分身引擎状态：demo=内置知识库演示（免费）；live=DeepSeek 直连；agentscope=Python 智能体 */
type EngineMode = "demo" | "live" | "agentscope";
const ENGINE_BADGE: Record<EngineMode, { label: string; title: string }> = {
  demo: { label: "演示模式", title: "当前由内置知识库模拟回答（免费）。管理员在 .env 配置 DEEPSEEK_API_KEY 或启动 agent-service 后自动切换为真实大模型。" },
  live: { label: "DeepSeek 驱动", title: "由 DeepSeek 大模型基于博主文章检索生成回答。" },
  agentscope: { label: "AgentScope 智能体", title: "由 AgentScope 智能体服务（DeepSeek + 检索工具）生成回答。" },
};

export default function AgentChat({
  author,
  agentQaCount,
  about,
}: {
  author: string;
  /** 全站浮窗等场景可不传，隐藏「已接待」行 */
  agentQaCount?: number;
  about?: string;
}) {
  const GREETING: Msg = {
    role: "agent",
    text: `你好，我是${author}的 AI 分身。${about ? `看你正在读《${about}》` : "关于博主写过的任何话题"}，尽管问。我的回答都会标注依据来源。`,
  };
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [engine, setEngine] = useState<EngineMode>("demo");
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/agent/status")
      .then((r) => r.json())
      .then((d: { mode?: EngineMode }) => d.mode && setEngine(d.mode))
      .catch(() => {});
  }, []);

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  function reset() {
    if (busy) return;
    setMsgs([GREETING]);
  }

  async function copyLast() {
    const last = [...msgs].reverse().find((m) => m.role === "agent" && m.text);
    if (!last) return;
    try {
      await navigator.clipboard.writeText(last.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文）时静默
    }
  }

  async function ask(q: string) {
    if (!q || busy) return;
    setBusy(true);
    setInput("");
    const history = msgs
      .filter((m) => m.text && !(m.role === "agent" && m.text === GREETING.text))
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: "user", text: q }, { role: "agent", text: "", cite: null }]);
    scrollBottom();
    const updateLast = (patch: Partial<Msg>) =>
      setMsgs((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch };
        return copy;
      });

    try {
      const res = await fetch("/api/agent/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, author, about, history }),
      });
      if (!res.ok) {
        // 401 未登录 / 402 余额不足 / 5xx：给出行动指引而非沉默
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        const hint =
          res.status === 401
            ? "先登录再来找我聊吧（右上角进入）。"
            : res.status === 402
              ? "你的墨水不够了——去墨仓签到或充值补给一下？"
              : (j.error ?? "服务暂时不可用");
        updateLast({ text: `⛔ ${hint}` });
        return;
      }
      if (!res.body) throw new Error("无响应流");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as { type: string; text?: string; citation?: string | null; message?: string };
            if (ev.type === "delta" && ev.text) {
              setMsgs((m) => {
                const copy = [...m];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, text: last.text + ev.text };
                return copy;
              });
              scrollBottom();
            } else if (ev.type === "cite") {
              updateLast({ cite: ev.citation ?? null });
            } else if (ev.type === "error") {
              updateLast({ text: "分身出了点状况：" + (ev.message ?? "未知错误") });
            }
          } catch {
            // 忽略不完整 JSON 行
          }
        }
      }
    } catch {
      updateLast({ text: "网络异常，分身暂时失联。" });
    } finally {
      setBusy(false);
      scrollBottom();
    }
  }

  return (
    <aside id="agent-panel" className="agent-panel agent-card" aria-label={`${author}分身问答`}>
      <div className="agent-head">
        <div className="agent-avatar" aria-hidden="true">
          {author.slice(0, 1)}
          <i className="agent-pulse" />
        </div>
        <div className="agent-id">
          <b>{author}的分身</b>
          {agentQaCount != null && <span>已接待 {agentQaCount.toLocaleString()} 次提问</span>}
        </div>
        <span
          className={"agent-engine" + (engine === "demo" ? " demo" : "")}
          title={ENGINE_BADGE[engine].title}
        >
          {ENGINE_BADGE[engine].label}
        </span>
        <span className={"agent-live" + (busy ? " busy" : "")}>{busy ? "思考中" : "在线"}</span>
      </div>
      <div className="chat" ref={chatRef} aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text}
            {m.role === "agent" && m.cite && m.text && (
              <div className="cite">
                <b>依据</b> {m.cite}
              </div>
            )}
          </div>
        ))}
        {busy && !msgs[msgs.length - 1]?.text && (
          <div className="msg agent typing-row">
            <span className="typing">
              <i></i>
              <i></i>
              <i></i>
            </span>
          </div>
        )}
      </div>
      <div className="chat-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => ask(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <div className="chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask(input.trim())}
          placeholder="向分身提问…"
          aria-label="向分身提问"
        />
        <button onClick={() => ask(input.trim())} disabled={busy} aria-label="发送提问">
          问
        </button>
      </div>
      <div className="chat-tools">
        <button onClick={reset} disabled={busy} title="清空对话重新开始">
          ↺ 清空
        </button>
        <button onClick={copyLast} disabled={busy} title="复制分身最近一条回答">
          {copied ? "✓ 已复制" : "⧉ 复制"}
        </button>
        <span className="chat-cost">{engine === "demo" ? "演示模式 · 免费" : "每问 5 滴墨水"}</span>
      </div>
      <p className="disclaimer">AI 生成 · 已标注来源段落，可能有偏差。博主可在后台复核纠正。</p>
    </aside>
  );
}
