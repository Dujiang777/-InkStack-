// 站内通知：评论/打赏/点赞/审核结果/封禁等事件 → notifications 表
// 原则：通知永不阻塞主流程，任何失败静默
import { getPool } from "./db";

export type NotifType = "comment" | "tip" | "review" | "like" | "unlock" | "system";

export async function notify(
  userId: number,
  type: NotifType,
  title: string,
  body?: string,
  link?: string
): Promise<void> {
  const pool = await getPool();
  if (!pool || !userId) return;
  try {
    await pool.query(
      "INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)",
      [userId, type, title.slice(0, 200), body?.slice(0, 500) ?? null, link?.slice(0, 255) ?? null]
    );
  } catch {
    /* 通知失败静默 */
  }
}
