package com.inkstack.auth;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
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
}
