// 独立 TOTP 计算器（测试用）：node scripts/totp-now.js <secret>
import { createHmac } from "node:crypto";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s) {
  let bits = 0, value = 0; const bytes = [];
  for (const ch of s.toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}
const secret = process.argv[2] || "";
const counter = Math.floor(Date.now() / 1000 / 30);
const buf = Buffer.alloc(8);
buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
buf.writeUInt32BE(counter % 0x100000000, 4);
const mac = createHmac("sha1", b32decode(secret)).update(buf).digest();
const off = mac[mac.length - 1] & 0x0f;
const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
console.log(String(bin % 1e6).padStart(6, "0"));
