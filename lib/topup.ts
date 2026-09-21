// 充值套件：套餐定义 + 订单创建 + 支付到账（事务）
// P0 演示通道：payOrder 直接将 pending 订单置为 paid 并到账（沙箱自闭环，不产生真实扣费）。
// P1 真实支付接入点：接微信支付 Native 下单后，payOrder 改由「支付回调验签」触发，
//    channel 字段记录 wechat/alipay；订单状态机不变（pending → paid）。
import { getPool } from "./db";

export type Pack = {
  key: string;
  name: string;
  cents: number; // 应付金额（分）
  points: number; // 到账点墨
  tag: string; // 角标：惠 / 推荐 / 空
  note: string; // 一句话卖点
};

export const PACKS: Pack[] = [
  { key: "starter", name: "尝鲜包", cents: 600, points: 600, tag: "", note: "约 60 次分身问答" },
  { key: "standard", name: "标准包", cents: 1800, points: 2200, tag: "惠", note: "多送 200 点 · 约 7 篇 AI 长文" },
  { key: "pro", name: "创作者包", cents: 5000, points: 6500, tag: "推荐", note: "多送 500 点 · 日更作者首选" },
  { key: "studio", name: "工作室包", cents: 12800, points: 17800, tag: "", note: "多送 1000 点 · 团队/高频使用" },
];

export function findPack(key: string): Pack | undefined {
  return PACKS.find((p) => p.key === key);
}

function makeOrderNo(): string {
  const d = new Date();
  const ts = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TP${ts}${rand}`;
}

export async function createOrder(
  userId: number,
  packKey: string
): Promise<{ ok: boolean; error?: string; orderNo?: string; pack?: Pack }> {
  const pack = findPack(packKey);
  if (!pack) return { ok: false, error: "套餐不存在" };
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库暂不可用" };
  try {
    const orderNo = makeOrderNo();
    await pool.query(
      `INSERT INTO topup_orders (user_id, order_no, pack_key, amount_cents, points, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [userId, orderNo, pack.key, pack.cents, pack.points]
    );
    return { ok: true, orderNo, pack };
  } catch {
    return { ok: false, error: "订单创建失败，请稍后再试" };
  }
}

// 模拟支付到账：pending → paid 原子流转（重复支付/越权/订单不存在一律拒绝），同事务加墨 + 落流水
export async function payOrder(
  userId: number,
  orderNo: string,
  channel = "demo"
): Promise<{ ok: boolean; error?: string; points?: number; balance?: number; pack?: Pack }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "数据库暂不可用" };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT o.pack_key, o.points, o.status, o.amount_cents
         FROM topup_orders o WHERE o.order_no = ? AND o.user_id = ? FOR UPDATE`,
      [orderNo, userId]
    );
    const o = (rows as Record<string, unknown>[])[0];
    if (!o) {
      await conn.rollback();
      return { ok: false, error: "订单不存在" };
    }
    if (String(o.status) !== "pending") {
      await conn.rollback();
      return { ok: false, error: "订单已支付或已关闭" };
    }
    const [upd] = await conn.query(
      `UPDATE topup_orders SET status = 'paid', paid_at = NOW(), channel = ?
        WHERE order_no = ? AND status = 'pending'`,
      [channel, orderNo]
    );
    if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
      await conn.rollback();
      return { ok: false, error: "订单状态异常，请稍后再试" };
    }
    const [bal] = await conn.query(
      "UPDATE users SET points_balance = points_balance + ? WHERE id = ?",
      [Number(o.points), userId]
    );
    if (Number((bal as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
      await conn.rollback();
      return { ok: false, error: "到账失败，请稍后再试" };
    }
    await conn.query("INSERT INTO point_ledger (user_id, delta, reason) VALUES (?, ?, ?)", [
      userId,
      Number(o.points),
      `充值到账·${findPack(String(o.pack_key))?.name ?? o.pack_key}`,
    ]);
    const [after] = await conn.query("SELECT points_balance FROM users WHERE id = ?", [userId]);
    await conn.commit();
    return {
      ok: true,
      points: Number(o.points),
      balance: Number((after as Record<string, unknown>[])[0]?.points_balance ?? 0),
      pack: findPack(String(o.pack_key)),
    };
  } catch {
    await conn.rollback();
    return { ok: false, error: "支付异常，请稍后再试" };
  } finally {
    conn.release();
  }
}
