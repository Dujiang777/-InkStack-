// POST /api/topup/pay — 支付到账
// v15.0 安全整改：demo 模拟支付通道仅限开发环境；生产环境到账只能由支付回调验签触发
// v17.2 严重级修复：原实现生产环境只拦 channel === "demo"，而 channel 是**客户端自报**的，
//   传 channel="wechat" / "alipay" 就能让 payOrder 把订单直接置为 paid 并到账——
//   即「零成本刷墨」（下单 17800 点墨 → 不付款 → 自称微信支付 → 到账）。
//   payOrder 本身不验签、不查支付平台结果，因此真支付回调接入前，
//   生产环境必须关闭整条「前端自助到账」通道。
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { dbEnabled } from "@/lib/db";
import { payOrder } from "@/lib/topup";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "登录后才能支付" }, { status: 401 });
  if (!dbEnabled()) return NextResponse.json({ error: "支付需要 MySQL" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { orderNo?: string; channel?: string };
  const orderNo = (body.orderNo ?? "").trim();
  if (!orderNo) return NextResponse.json({ error: "缺少订单号" }, { status: 400 });

  const channel = ["demo", "wechat", "alipay"].includes(body.channel ?? "")
    ? (body.channel as string)
    : "demo";
  // 生产环境：任何渠道都不接受前端自助到账。真微信支付上线时，
  // 由支付回调路由（服务端验签 + 金额以订单为准 + 幂等）调用 payOrder，
  // 不经过本接口。
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "该支付通道暂未开放" }, { status: 501 });
  }
  const r = await payOrder(user.id, orderNo, channel);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, points: r.points, balance: r.balance, pack: r.pack });
}
