// GET /api/agent/status — 分身引擎状态透明化：告诉前端当前回答由什么驱动
// mode:
//   agentscope → AGENT_SERVICE_URL 已配置 **且 /health 探活成功**（Python 智能体 + DeepSeek + 检索工具）
//   live       → DEEPSEEK_API_KEY + MySQL 全文检索（Node 直连 DeepSeek）
//   demo       → 内置知识库演示回答（免费，非真实大模型）
// 探活 1.2s 超时：服务没启动时如实回落，避免徽标谎报。
import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/db";

export async function GET() {
  const agentUrl = process.env.AGENT_SERVICE_URL;
  if (agentUrl) {
    try {
      const res = await fetch(`${agentUrl.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(1200),
      });
      if (res.ok) return NextResponse.json({ ok: true, mode: "agentscope" });
    } catch {
      /* 服务未启动 → 继续判定 */
    }
  }
  if (process.env.DEEPSEEK_API_KEY && dbEnabled()) {
    return NextResponse.json({ ok: true, mode: "live" });
  }
  return NextResponse.json({ ok: true, mode: "demo" });
}
