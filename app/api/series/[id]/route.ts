// PATCH  /api/series/[id] — 更新专栏（题名/简介/篇目整体重排，仅作者本人）
// DELETE /api/series/[id] — 删除专栏（条目级联清除）
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { updateSeriesMeta, deleteSeries, setSeriesItems } from "@/lib/data";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "专栏不存在" }, { status: 404 });

  let body: { title?: string; description?: string; slugs?: string[]; bundlePrice?: unknown };
  try {
    body = (await req.json()) as { title?: string; description?: string; slugs?: string[]; bundlePrice?: unknown };
  } catch {
    return NextResponse.json({ error: "请求格式有误" }, { status: 400 });
  }

  try {
    if (body.title !== undefined || body.description !== undefined || body.bundlePrice !== undefined) {
      const patch: { title?: string; description?: string; bundlePrice?: number | null } = {};
      if (body.title !== undefined) {
        const t = body.title.trim();
        if (t.length < 2 || t.length > 60) return NextResponse.json({ error: "专栏题名需 2-60 字" }, { status: 400 });
        patch.title = t;
      }
      if (body.description !== undefined) patch.description = body.description.trim();
      if (body.bundlePrice !== undefined) {
        // null / "" / 0 = 关闭打包；1-99999 = 一口价
        const raw = body.bundlePrice;
        if (raw === null || raw === "") patch.bundlePrice = null;
        else {
          const n = Math.floor(Number(raw) || 0);
          if (n < 0 || n > 99999) return NextResponse.json({ error: "打包价需在 1-99999 点墨之间" }, { status: 400 });
          patch.bundlePrice = n > 0 ? n : null;
        }
      }
      const ok = await updateSeriesMeta(id, user.id, patch);
      if (!ok) return NextResponse.json({ error: "专栏不存在或无权修改" }, { status: 403 });
    }
    if (Array.isArray(body.slugs)) {
      const slugs = body.slugs.map(String).slice(0, 100);
      const ok = await setSeriesItems(id, user.id, slugs);
      if (!ok) {
        return NextResponse.json({ error: "篇目设置失败：专栏不存在，或所选文章未发布/未过审/不归你所有" }, { status: 400 });
      }
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "更新失败，请稍后再试" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "专栏不存在" }, { status: 404 });
  try {
    const ok = await deleteSeries(id, user.id);
    if (!ok) return NextResponse.json({ error: "专栏不存在或无权删除" }, { status: 403 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "删除失败，请稍后再试" }, { status: 500 });
  }
}
