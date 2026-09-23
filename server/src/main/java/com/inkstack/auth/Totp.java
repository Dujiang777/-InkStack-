package com.inkstack.auth;

import com.inkstack.common.NodeShapes;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * RFC 6238 两步验证码，参数与 lib/totp.ts 逐项对齐：HMAC-SHA1 / 6 位 / 30 秒步长 / ±1 窗口。
 *
 * <p>密钥是 160 位随机数的 base32（RFC 4648 无填充）文本形式，由 Node 侧生成后存在
 * users.totp_secret，所以 Java 必须能吃同一串文本，且必须用同一套动态截断取码。
 */
public final class Totp {

  private static final String B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  private static final int STEP_SECONDS = 30;
  private static final int WINDOW = 1;
  private static final SecureRandom RANDOM = new SecureRandom();

  private Totp() {}

  public static boolean verify(String secretB32, String code) {
    if (secretB32 == null || code == null) {
      return false;
    }
    String clean = code.replaceAll("\\D", "");
    if (clean.length() != 6) {
      return false;
    }
    byte[] secret;
    try {
      secret = base32Decode(secretB32);
    } catch (IllegalArgumentException malformed) {
      return false;
    }
    long counter = System.currentTimeMillis() / 1000 / STEP_SECONDS;
    for (int i = -WINDOW; i <= WINDOW; i++) {
      if (MessageDigest.isEqual(
          at(secret, counter + i).getBytes(java.nio.charset.StandardCharsets.UTF_8),
          clean.getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
        return true;
      }
    }
    return false;
  }

  private static String at(byte[] secret, long counter) {
    byte[] mac = hmacSha1(secret, ByteBuffer.allocate(8).putLong(counter).array());
    int offset = mac[mac.length - 1] & 0x0F;
    int binary = ((mac[offset] & 0x7F) << 24)
        | ((mac[offset + 1] & 0xFF) << 16)
        | ((mac[offset + 2] & 0xFF) << 8)
        | (mac[offset + 3] & 0xFF);
    return String.format("%06d", binary % 1_000_000);
  }

  private static byte[] hmacSha1(byte[] key, byte[] data) {
    try {
      Mac mac = Mac.getInstance("HmacSHA1");
      mac.init(new SecretKeySpec(key, "HmacSHA1"));
      return mac.doFinal(data);
    } catch (Exception e) {
      throw new IllegalStateException("HMAC-SHA1 失败", e);
    }
  }

  private static byte[] base32Decode(String input) {
    String clean = input.toUpperCase().replaceAll("[^A-Z2-7]", "");
    int bits = 0;
    int value = 0;
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    for (int i = 0; i < clean.length(); i++) {
      value = (value << 5) | B32.indexOf(clean.charAt(i));
      bits += 5;
      if (bits >= 8) {
        out.write((value >>> (bits - 8)) & 0xFF);
        bits -= 8;
      }
    }
    return out.toByteArray();
  }

  /** 生成 160 位随机密钥并编码为 base32（验证器 App 手动输入的格式）。 */
  public static String generateSecret() {
    byte[] raw = new byte[20];
    RANDOM.nextBytes(raw);
    return base32Encode(raw);
  }

  static String base32Encode(byte[] bytes) {
    StringBuilder out = new StringBuilder();
    int bits = 0;
    int value = 0;
    for (byte b : bytes) {
      value = (value << 8) | (b & 0xFF);
      bits += 8;
      while (bits >= 5) {
        out.append(B32.charAt((value >>> (bits - 5)) & 31));
        bits -= 5;
      }
    }
    if (bits > 0) {
      out.append(B32.charAt((value << (5 - bits)) & 31));
    }
    return out.toString();
  }

  /** otpauth:// 迁移链接：参数顺序与 Node 的 URLSearchParams 一致（secret,issuer,algorithm,digits,period）。 */
  public static String otpauthUrl(String secret, String account) {
    String label = urlEncode("InkStack:" + account);
    return "otpauth://totp/" + label
        + "?secret=" + secret + "&issuer=InkStack&algorithm=SHA1&digits=6&period=30";
  }

  /** encodeURIComponent 的未保留字符集：字母数字与 -_.!~*'()，其余按 UTF-8 百分号编码。 */
  private static String urlEncode(String value) {
    StringBuilder out = new StringBuilder();
    for (byte b : value.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
      char c = (char) (b & 0xFF);
      boolean safe = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
          || c == '-' || c == '.' || c == '_' || c == '!' || c == '~' || c == '*' || c == '\''
          || c == '(' || c == ')';
      if (safe) {
        out.append(c);
      } else {
        out.append('%').append(String.format("%02X", b));
      }
    }
    return out.toString();
  }

  /** 一次性备份码：形如 4XK9-2QM7 的 10 枚，库里只存 sha256 hex。 */
  public static BackupCodes generateBackupCodes() {
    List<String> plain = new ArrayList<>();
    List<String> hashed = new ArrayList<>();
    for (int i = 0; i < 10; i++) {
      byte[] raw = new byte[6];
      RANDOM.nextBytes(raw);
      // 6 字节 base64url 是 8 个字符，但去掉 -/_ 之后长度会掉到 5~8：
      // Node 用 slice 安静地给出短一点的码，这里也必须用 NodeShapes.slice，
      // 用 substring 就是在"随机数恰好带上 -/_"的那一天线上 500。
      String token = NodeShapes.slice(
          java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw)
              .replaceAll("[-_]", ""), 8).toUpperCase();
      String code = NodeShapes.slice(token, 4) + "-" + NodeShapes.slice(token, 4, 8);
      plain.add(code);
      hashed.add(com.inkstack.common.Hex.sha256Hex(code));
    }
    return new BackupCodes(plain, hashed);
  }

  public record BackupCodes(List<String> plain, List<String> hashed) {}
}
