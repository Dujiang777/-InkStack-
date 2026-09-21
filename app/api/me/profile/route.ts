// PATCH /api/me/profile — 编辑个人资料（昵称/印文/印泥/印式/简介），登录限定
// v17.4 印章工坊：新增 avatarTone（印泥色）与 avatarShape（印式），白名单校验后落库
import { NextResponse } from "next/server";
import { getCurrentUser, cleanNickname } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { cleanAvatarTone, cleanAvatarShape } from "@/lib/avatar";
import { ensureAvatarColumns } from "@/lib/data";

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    nickname?: string;
    avatarText?: string;
    avatarTone?: string;
    avatarShape?: string;
    bio?: string;
  };
  const nickname = cleanNickname(body.nickname);
  const avatarText = (body.avatarText ?? "").trim().slice(0, 2);
  const avatarTone = cleanAvatarTone(body.avatarTone);
  const avatarShape = cleanAvatarShape(body.avatarShape);
  const bio = (body.bio ?? "").trim().slice(0, 120);

  if (!nickname) return NextResponse.json({ error: "昵称不能为空" }, { status: 400 });

  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "数据库不可用" }, { status: 500 });
  try {
    await ensureAvatarColumns(pool);
    await pool.query(
      `UPDATE users SET nickname = ?, avatar_text = ?, avatar_tone = ?, avatar_shape = ?, bio = ? WHERE id = ?`,
      [nickname, avatarText || nickname.slice(0, 1), avatarTone, avatarShape, bio || null, user.id]
    );
    return NextResponse.json({
      ok: true,
      nickname,
      avatarText: avatarText || nickname.slice(0, 1),
      avatarTone,
      avatarShape,
      bio,
    });
  } catch {
    return NextResponse.json({ error: "保存失败（数据库异常）" }, { status: 500 });
  }
}
