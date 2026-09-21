// 注册邮箱验证码：存取 + 校验（sha256 落库，10 分钟有效，5 次尝试上限，
// 签发冷却 60s / 10 分钟窗口最多 5 次）。表懒建，globalThis 防热重载重复建。
import { createHash, randomInt } from "node:crypto";
import type { Pool } from "mysql2/promise";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const WINDOW_LIMIT_MS = 10 * 60 * 1000;
const WINDOW_MAX = 5;

const g = globalThis as typeof globalThis & { __inkCodeReady?: boolean };

function codeHash(email: string, code: string): string {
  return createHash("sha256").update(`${email.toLowerCase()}::${code}`).digest("hex");
}

async function ensureTable(pool: Pool): Promise<void> {
  if (g.__inkCodeReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS email_codes (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email      VARCHAR(190) NOT NULL,
    code_hash  CHAR(64) NOT NULL,
    purpose    VARCHAR(20) NOT NULL DEFAULT 'register',
    attempts   INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at DATETIME(3) NOT NULL,
    INDEX idx_ec_email (email, created_at DESC)
  ) ENGINE=InnoDB`);
  g.__inkCodeReady = true;
}

export type IssueResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

/** 签发验证码（冷却与频控通过则返回明文 code 交给 mailer） */
export async function issueCode(pool: Pool, email: string, purpose = "register"): Promise<IssueResult> {
  await ensureTable(pool);
  const mail = email.toLowerCase();
  // v17.8：冷却/窗口判定与 INSERT 收进**同一事务**，窗口查询加 FOR UPDATE。
  //   原实现是「先 SELECT 判冷却 → 再 INSERT」两条自动提交语句，中间无任何锁：
  //   实测 40 个并发签发请求**全部**通过判定，单次爆发给同一邮箱落库 40 条验证码
  //   （期望 1 条），即 60s 冷却与「10 分钟 5 次」窗口在并发下形同虚设——
  //   配合可伪造的 X-Forwarded-For（TRUST_PROXY 未设时的既有降级），
  //   可对任意邮箱无限发信（轰炸收件箱 + 烧光 SMTP 配额与域名信誉）。
  //   加锁后：同一 (email, purpose) 的签发被串行化，后到者一定读到已落库的那一行。
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [recent] = await conn.query(
      `SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT ${WINDOW_MAX} FOR UPDATE`,
      [mail, purpose]
    );
    const rows = recent as { created_at: Date }[];
    if (rows.length > 0) {
      const last = new Date(rows[0].created_at).getTime();
      if (Date.now() - last < RESEND_COOLDOWN_MS) {
        await conn.rollback();
        const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last)) / 1000);
        return { ok: false, error: `发送太频繁，请 ${wait} 秒后再试` };
      }
      if (rows.length >= WINDOW_MAX && Date.now() - new Date(rows[WINDOW_MAX - 1].created_at).getTime() < WINDOW_LIMIT_MS) {
        await conn.rollback();
        return { ok: false, error: "验证码请求过多，请 10 分钟后再试" };
      }
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await conn.query(
      `INSERT INTO email_codes (email, code_hash, purpose, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? MICROSECOND))`,
      [mail, codeHash(mail, code), purpose, CODE_TTL_MS * 1000]
    );
    await conn.commit();
    return { ok: true, code };
  } catch {
    await conn.rollback().catch(() => {});
    return { ok: false, error: "验证码签发失败，请稍后再试" };
  } finally {
    conn.release();
  }
}

export type CheckResult = { ok: true } | { ok: false; error: string };

/** 校验并消费验证码（成功后即删；错误累计 5 次作废） */
export async function checkCode(pool: Pool, email: string, code: string, purpose = "register"): Promise<CheckResult> {
  await ensureTable(pool);
  const mail = email.toLowerCase();
  try {
    const [rows0] = await pool.query(
      `SELECT id, attempts, expires_at FROM email_codes
        WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1`,
      [mail, purpose]
    );
    const row = (rows0 as { id: number; attempts: number; expires_at: Date | string }[])[0];
    if (!row) return { ok: false, error: "请先获取邮箱验证码" };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await pool.query(`DELETE FROM email_codes WHERE id = ?`, [row.id]);
      return { ok: false, error: "验证码已过期，请重新获取" };
    }
    const [hashRows] = await pool.query(`SELECT code_hash FROM email_codes WHERE id = ?`, [row.id]);
    const storedHash = String((hashRows as { code_hash: string }[])[0]?.code_hash ?? "");
    if (codeHash(mail, code.trim()) !== storedHash) {
      // v17.8：计数改为**原子自增**。原实现是「SELECT 出 attempts → +1 → UPDATE 写回」的读-改-写，
      //   并发下多个请求读到同一个旧值、再写回同一个新值，计数被静默吞掉——
      //   实测 60 个并发错误码请求**全部**被判为「验证码不正确」，attempts 最终只停在 2，
      //   5 次上限形同虚设（配合 XFF 可伪造的 IP 限流即为可无限次猜码）。
      const [inc] = await pool.query(`UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?`, [
        row.id,
      ]);
      if (Number((inc as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
        // 并发下已被其它请求作废/消费
        return { ok: false, error: "请先获取邮箱验证码" };
      }
      const [afterRows] = await pool.query(`SELECT attempts FROM email_codes WHERE id = ?`, [row.id]);
      const attempts = Number(
        (afterRows as { attempts: number }[])[0]?.attempts ?? MAX_ATTEMPTS
      );
      if (attempts >= MAX_ATTEMPTS) {
        const [del] = await pool.query(`DELETE FROM email_codes WHERE id = ?`, [row.id]);
        return Number((del as { affectedRows?: number }).affectedRows ?? 0) === 1
          ? { ok: false, error: "错误次数过多，验证码已作废，请重新获取" }
          : { ok: false, error: "请先获取邮箱验证码" };
      }
      return { ok: false, error: `验证码不正确（还可尝试 ${MAX_ATTEMPTS - attempts} 次）` };
    }
    // v17.8：消费改为**条件删除并核验影响行数**。原实现是「先 SELECT 比对 → 再 DELETE」，
    //   同一枚码在两个并发请求里会双双比对成功、双双返回 ok（实测可复现），
    //   即一次性验证码可被消费两次。改为「删掉了才算通过」，天然幂等且无竞态窗口。
    const [consumed] = await pool.query(
      `DELETE FROM email_codes WHERE id = ? AND code_hash = ?`,
      [row.id, storedHash]
    );
    if (Number((consumed as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
      return { ok: false, error: "验证码已被使用，请重新获取" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "验证码校验失败，请稍后再试" };
  }
}
