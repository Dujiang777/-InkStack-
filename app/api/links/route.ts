// POST /api/links — 提交外链审核（创作台插入外链时自动触发）
// GET /api/links — 待审核列表（admin）
// PUT /api/links — 审核（admin）：{ id, action: "approve" | "reject" }
// v17.2：POST 原来完全无鉴权——任何人可匿名 POST 域名，往运营审核队列灌数据
//        （domain 唯一键只防重复域名，换不同域名即可无限堆行，120 次/分的全局限流拦不住）。
//        现在要求登录：游客本就不能发文，其外链也不会出现在任何已发布文章里。
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { extractDomain, submitLinkForReview } from "@/lib/link-policy";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能提交外链审核" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { url?: string; note?: string };
  const url = (body.url ?? "").trim();
  if (!extractDomain(url)) {
    return NextResponse.json({ error: "url 无效" }, { status: 400 });
  }
  await submitLinkForReview(url, body.note ?? "");
  return NextResponse.json({ ok: true, message: "已提交审核，通过前该链接将以「待审核」样式展示" });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) {
    return NextResponse.json({ error: "仅管理员可查看" }, { status: 403 });
  }
  const pool = await getPool();
  if (!pool) return NextResponse.json({ links: [] });
  const [rows] = await pool.query(
    `SELECT id, domain, url, note, status, DATE_FORMAT(created_at,'%m-%d %H:%i') AS createdAt
     FROM link_whitelist ORDER BY status ASC, created_at DESC LIMIT 50`
  );
  return NextResponse.json({
    links: (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), domain: String(r.domain), url: String(r.url ?? ""),
      note: String(r.note ?? ""), status: String(r.status), createdAt: String(r.createdAt),
    })),
  });
}

export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) {
    return NextResponse.json({ error: "仅管理员可审核" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: number; action?: string };
  if (!body.id || !["approve", "reject"].includes(body.action ?? "")) {
    return NextResponse.json({ error: "参数：id + action(approve|reject)" }, { status: 400 });
  }
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库未配置" }, { status: 503 });
  await pool.query(
    `UPDATE link_whitelist SET status = ? WHERE id = ?`,
    [body.action === "approve" ? "approved" : "rejected", body.id]
  );
  return NextResponse.json({ ok: true });
}
