// TOTP 双因素认证（RFC 6238，兼容 Google Authenticator / 微信小程序验证器）
// 零外部依赖：base32 编解码 + HMAC-SHA1 滚动码，6 位 / 30 秒步长 / 允许 ±1 窗口时钟漂移
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 生成 160 位随机密钥并编码为 base32（验证器 App 手动输入格式） */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 计算某时间步的 TOTP 码（HMAC-SHA1，动态截断） */
function totpAt(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/** 校验 6 位验证码：允许 ±1 窗口（±30s 时钟漂移）；恒时比较防时序侧信道 */
export function verifyTotp(secretB32: string, code: string, window = 1): boolean {
  const clean = (code ?? "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const target = Buffer.from(clean);
  for (let i = -window; i <= window; i++) {
    const expect = Buffer.from(totpAt(secret, counter + i));
    if (expect.length === target.length && timingSafeEqual(expect, target)) return true;
  }
  return false;
}

/** 生成 otpauth:// 迁移链接（验证器扫码/手动添加） */
export function otpauthUrl(secret: string, account: string, issuer = "InkStack"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 生成 10 个一次性备份码（形如 4X9K-2QM7），返回明文数组 + sha256 十六进制数组 */
export function generateBackupCodes(): { plain: string[]; hashed: string[] } {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < 10; i++) {
    const raw = randomBytes(6).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    plain.push(code);
    hashed.push(createHash("sha256").update(code).digest("hex"));
  }
  return { plain, hashed };
}

export function sha256Hex(s: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}
