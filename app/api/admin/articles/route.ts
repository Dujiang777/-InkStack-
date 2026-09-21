// POST /api/admin/articles — 运营内容管理（admin 限定）
// body: { slug, action, note? }
// action ∈ publish | unpublish | pin | unpin | feature | unfeature | approve | reject
// approve/reject 为审核动作：驳回必须带 note，通过/驳回都会通知作者；全部动作落审计日志
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { adminSetArticle, adminReviewArticle, adminSetArticlePrice, logAdminAction, type AdminAction } from "@/lib/data";
import { notify } from "@/lib/notify";

const ACTIONS: AdminAction[] = ["publish", "unpublish", "pin", "unpin", "feature", "unfeature"];
const REVIEW_ACTIONS = ["approve", "reject"] as const;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  if (!isStaff(user.role)) {
    return NextResponse.json({ error: "仅管理团队可操作" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { slug?: string; action?: string; note?: string };
  const slug = String(body.slug ?? "").trim();
  const action = body.action ?? "";
  if (!slug) {
    return NextResponse.json({ error: "参数须为 { slug, action, note? }" }, { status: 400 });
  }

  /* ---------- 审核动作 ---------- */
  if ((REVIEW_ACTIONS as readonly string[]).includes(action)) {
    const decision = action === "approve" ? "approve" : "reject";
    const result = await adminReviewArticle(slug, decision, body.note);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    logAdminAction(user.id, `review:${decision}`, "article", slug, decision === "reject" ? body.note : "审核通过");
    if (result.authorId) {
      if (decision === "approve") {
        notify(result.authorId, "review", "你的文章已通过审核", `《${slug}》现已公开可见`, `/article/${slug}`);
      } else {
        notify(
          result.authorId,
          "review",
          "文章未通过审核",
          `原因：${(body.note ?? "").trim() || "内容不符合社区规范"}。可在书房修改后重新提交。`,
          `/study`
        );
      }
    }
    return NextResponse.json({ ok: true, slug, action });
  }

  /* ---------- 运营改价（v17.1）：直接调整解锁价与限时折扣 ---------- */
  if (action === "price") {
    const body2 = body as { unlockPrice?: number; discountPrice?: number };
    const result = await adminSetArticlePrice(slug, Number(body2.unlockPrice ?? 0), Number(body2.discountPrice ?? 0));
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    logAdminAction(user.id, "article:price", "article", slug, `解锁 ${body2.unlockPrice ?? 0} / 折扣 ${body2.discountPrice ?? 0}`);
    return NextResponse.json({ ok: true, slug, action });
  }

  /* ---------- 常规运营动作 ---------- */
  if (!ACTIONS.includes(action as AdminAction)) {
    return NextResponse.json(
      { error: "action ∈ publish|unpublish|pin|unpin|feature|unfeature|approve|reject" },
      { status: 400 }
    );
  }

  const result = await adminSetArticle(slug, action as AdminAction);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  logAdminAction(user.id, `article:${action}`, "article", slug);
  return NextResponse.json({ ok: true, slug, action });
}
