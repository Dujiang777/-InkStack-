// 站内通知：评论/打赏/点赞/审核结果/封禁等事件 → notifications 表
// 原则：通知永不阻塞主流程，任何失败静默
import { getPool } from "./db";

export type NotifType = "comment" | "tip" | "review" | "like" | "unlock" | "system";

const gNotif = globalThis as unknown as { __inkNotifEnumReady?: boolean };

/** 懒迁移：notifications.type 枚举补 'unlock'（旧库 ENUM 无此值，插入会静默失败） */
async function ensureUnlockEnum(): Promise<void> {
  if (gNotif.__inkNotifEnumReady) return;
  const pool = await getPool();
  if (!pool) return;
  try {
    await pool.query(
      `ALTER TABLE notifications MODIFY type ENUM('comment','tip','review','like','unlock','system') NOT NULL DEFAULT 'system'`
    );
    gNotif.__inkNotifEnumReady = true;
  } catch {
    /* 迁移失败静默，通知照旧降级 */
  }
}

export async function notify(
  userId: number,
  type: NotifType,
  title: string,
  body?: string,
  link?: string
): Promise<void> {
  const pool = await getPool();
  if (!pool || !userId) return;
  if (type === "unlock") await ensureUnlockEnum();
  try {
    await pool.query(
      "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)",
      [userId, type, title.slice(0, 200), body?.slice(0, 500) ?? null, link?.slice(0, 255) ?? null]
    );
  } catch {
    /* 通知失败静默 */
  }
}
