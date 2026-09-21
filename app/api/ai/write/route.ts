// POST /api/ai/write — AI 写作助手（续写 / 润色 / 起标题 / 推荐选题）
// 链路：Next.js → AgentScope 服务 /ai/write（ReActAgent + DeepSeek，文风注入 system prompt）
// 计费（分档）：续写 15 · 润色 10 · 起标题 5 · 推荐选题 5（DB 模式登录用户，事务+流水）
// v17.4 计费口径整改：原来「先扣后生成 + 失败 creditPoints 补偿」是两段式，
//   补偿本身失败即永久丢墨，且兜底模板也会先扣后用（文案还谎报"已退回"）。
//   现改为「只读探针预检 → 上游确认可用后才扣」，彻底去掉补偿路径，
//   模板兜底不再扣墨。钱只在真实产出时动一次，不存在需要回滚的中间态。
// 降级：Python 服务未启动或非 live → 返回内置模板文本（不扣积分）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { spendPoints, peekBalance } from "@/lib/points";
import { dbEnabled } from "@/lib/db";

const LABELS: Record<string, string> = {
  continue: "续写",
  polish: "润色",
  title: "起标题",
  topic: "推荐选题",
};

const PRICES: Record<string, number> = {
  continue: 15,
  polish: 10,
  title: 5,
  topic: 5,
};

/** 单次请求草稿上限（与文章正文/草稿保存同口径） */
const MAX_DRAFT = 100_000;

// 演示模板（Python 服务不可用时兜底）
const CONTENT: Record<string, string> = {
  continue:
    "\n\n具体展开之前，先给一个可复现的判据：用 EXPLAIN ANALYZE 跑一遍你的典型查询，如果执行计划里 Filter 节点的耗时占比超过 40%，说明标量过滤正在大量「白检」——向量算出来的相似度被业务条件扔掉了大半。这才是混合检索该出场的时候，而不是矩阵里数字变大的那一刻。\n\n选型是知识问题，时机是成本问题。大部分团队死在后者。",
  polish:
    "\n技术选型最大的陷阱，不是选错，而是拿着别人的规模做自己的决定。\n\n文章不到一万篇时，pgvector 的 HNSW 索引足够把召回率压上 95%，查询耗时个位数毫秒。此刻引入独立向量库，你收获的清单很确定：一个需要运维的有状态服务、一份新增的内存账单，和每个新成员都要重读一遍的部署文档。\n\n规模没到，架构先行——是用今天的确定性，为明天还不存在的问题付利息。",
  title:
    "\n1. pgvector 够用了：别急着上专用向量库\n2. 你的向量库焦虑，可能只是数据没到量级\n3. 在引入专用向量库之前，请先跑一次 EXPLAIN ANALYZE\n4. 一万篇以下，Postgres 就是最好的向量数据库\n5. 向量库选型的真正分界线：不是数据量，是过滤耦合",
  topic:
    "\n1. 为什么我把博客的检索从向量库换回了 MySQL 全文索引\n2. 给 AI 分身喂了 20 篇旧文之后，它学会了我最坏的表达习惯\n3. 个人博主的 RAG：从「能检索」到「敢引用」差了哪三步\n4. 流式输出的体验设计：让读者等得起的前 300 毫秒\n5. 博客平台的积分经济：为什么免费的 AI 一定被玩死",
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    mode?: string;
    draft?: string;
    author?: string;
  };
  const mode = body.mode ?? "";
  if (!LABELS[mode]) {
    return NextResponse.json(
      { error: "mode 须为 continue | polish | title | topic" },
      { status: 400 }
    );
  }
  // v18.0：入参长度收口。原实现 draft 完全不设上限——登录用户可 POST 一个几十 MB 的
  //   草稿，req.json() 全量缓冲进内存后再原样转发给 AgentScope 服务，是内存/CPU 放大面
  //   （middleware 的限流只管请求**条数**，不管单条 body 大小）。
  //   /api/agent/ask 早已对 question(500)/历史(600) 逐项截断，此处补齐同一口径：
  //   上限取与文章正文一致的 10 万字（创作台保存草稿本身也是这个上限，正常流程不会触发）。
  const rawDraft = body.draft ?? "";
  if (rawDraft.length > MAX_DRAFT) {
    return NextResponse.json({ error: "草稿过长（上限 10 万字）" }, { status: 400 });
  }
  const draft = rawDraft.trim();
  const author = (body.author ?? "博主").trim().slice(0, 40);
  const cost = PRICES[mode];

  // DB 模式：登录 + 只读余额预检（真正扣款延后到「上游确认可用」之后）
  let user: { id: number } | null = null;
  let pointsNote = "演示模式 · 不扣墨水";
  if (dbEnabled()) {
    const u = await getCurrentUser();
    if (!u) {
      return NextResponse.json({ error: "登录后才能使用 AI 写作助手" }, { status: 401 });
    }
    const bal = await peekBalance(u.id);
    if (bal < cost) {
      return NextResponse.json(
        { error: `积分不足（余额 ${bal}，本次需 ${cost}）` },
        { status: 402 }
      );
    }
    user = { id: u.id };
  }

  // 首选 AgentScope 服务真实生成
  const agentUrl = process.env.AGENT_SERVICE_URL;
  if (agentUrl) {
    try {
      const upstream = await fetch(`${agentUrl.replace(/\/$/, "")}/ai/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, draft: draft || `（作者尚未写下草稿，主题：${author} 的技术专栏）`, author }),
        signal: AbortSignal.timeout(90_000),
      });
      if (upstream.ok) {
        const data = (await upstream.json()) as { text?: string };
        if (typeof data.text === "string" && data.text.trim()) {
          // 上游确认产出 → 此时才扣费。扣费失败（并发花超）则不下发内容，
          // 保证「付了钱才有货、货出了必然付了钱」。
          if (user) {
            const spend = await spendPoints(user.id, cost, `AI写作·${LABELS[mode]}`);
            if (!spend.ok) {
              return NextResponse.json({ error: spend.error }, { status: 402 });
            }
            pointsNote = `已扣 ${cost} 滴墨水 · 余额 ${spend.balance}`;
          }
          return NextResponse.json({
            label: LABELS[mode],
            text: data.text,
            aiGenerated: true,
            cost,
            pointsNote,
          });
        }
      }
      // 上游异常或非 live → 落入模板兜底
    } catch {
      // 服务未启动 / 超时 → 模板兜底
    }
  }

  // 模板兜底：内容不是真实生成，不扣积分
  if (user) pointsNote = "模板兜底 · 本次不扣墨水";

  return NextResponse.json({
    label: LABELS[mode],
    text: CONTENT[mode],
    aiGenerated: true,
    cost,
    pointsNote,
    fallback: true,
  });
}
