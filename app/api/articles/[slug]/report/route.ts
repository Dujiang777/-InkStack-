// POST /api/articles/[slug]/report — 登录读者举报文章（进入运营台处理队列）
// 防重：同一用户对同一目标的未处理举报只保留一条
// v18.0：去重从「SELECT 判重 → INSERT」改为 `submitReport()` 的单事务 + 文章行 FOR UPDATE，
//        原写法两句之间无锁无唯一键，20 并发实测落库 17 行（详见 lib/data.ts 的 submitReport 注释）。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";
import { submitReport } from "@/lib/data";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能举报" }, { status: 401 });
  const { slug } = await params;
  if (!dbEnabled()) return NextResponse.json({ error: "数据库暂不可用" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = (body.reason ?? "").trim().slice(0, 255);
  if (reason.length < 2) return NextResponse.json({ error: "请填写举报原因（至少 2 字）" }, { status: 400 });

  const r = await submitReport(user.id, { type: "article", slug }, reason);
  if (!r.ok) {
    if (r.code === "not_found") {
      return NextResponse.json({ error: "文章不存在" }, { status: 404 });
    }
    if (r.code === "duplicate") {
      return NextResponse.json({ error: "该文章已有你提交的举报待处理，请耐心等待" }, { status: 409 });
    }
    return NextResponse.json({ error: "举报失败，请稍后再试" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, message: "举报已提交，运营会尽快核查" });
}
