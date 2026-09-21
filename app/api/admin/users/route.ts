// POST /api/admin/users — 用户管理（admin/developer 限定）
// body: { userId, action: ban|unban|grant|revoke|setRole, amount?, role? }
// 所有动作落审计日志；封禁/积分变动/角色变更通知当事用户
// v17.1：developer 为最高角色；setRole 仅 developer 可用，且不能动 developer 账号
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { adminSetUser, logAdminAction } from "@/lib/data";
import { notify } from "@/lib/notify";

const ACTIONS = ["ban", "unban", "grant", "revoke", "setRole"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "仅管理团队可操作" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { userId?: number; action?: string; amount?: number; role?: string };
  const userId = Number(body.userId);
  const action = body.action as Action;
  if (!userId || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: "参数须为 { userId, action: ban|unban|grant|revoke|setRole, amount?, role? }" }, { status: 400 });
  }
  // 角色管理是 developer 专属能力（admin 看得到下拉但服务端仍会拒绝）
  if (action === "setRole" && user.role !== "developer") {
    return NextResponse.json({ error: "仅开发者可变更用户角色" }, { status: 403 });
  }

  const result = await adminSetUser(userId, action, body.amount, body.role);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const label =
    action === "ban"
      ? "封禁账号"
      : action === "unban"
        ? "解除封禁"
        : action === "grant"
          ? `发放 ${body.amount} 点墨`
          : action === "revoke"
            ? `扣回 ${body.amount} 点墨`
            : `角色变更为 ${body.role}`;

  logAdminAction(user.id, `user:${action}`, "user", userId, label);
  if (action === "setRole") {
    const roleLabel: Record<string, string> = { reader: "读者", author: "作者", admin: "管理员" };
    notify(
      userId,
      "system",
      "你的账号角色已调整",
      `运营台已将你的角色调整为「${roleLabel[String(body.role)] ?? body.role}」`,
      "/me"
    );
  } else {
    notify(
      userId,
      "system",
      action === "ban" ? "你的账号已被封禁" : action === "unban" ? "账号封禁已解除" : `墨仓变动：${label}`,
      action === "ban" ? "如有疑问请联系平台邮箱申诉" : action === "grant" || action === "revoke" ? "由平台运营操作，可在墨仓流水中核对" : "欢迎回来，继续创作吧",
      action === "grant" || action === "revoke" ? "/points" : undefined
    );
  }

  return NextResponse.json({ ok: true, userId, action });
}
