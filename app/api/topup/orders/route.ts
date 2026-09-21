// POST /api/topup/orders — 创建充值订单（登录必需；返回 orderNo 供收银台支付）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";
import { createOrder, PACKS } from "@/lib/topup";

export async function GET() {
  return NextResponse.json({ packs: PACKS });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能充值" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "充值需要 MySQL" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { packKey?: string };
  const r = await createOrder(user.id, (body.packKey ?? "").trim());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, orderNo: r.orderNo, pack: r.pack });
}
