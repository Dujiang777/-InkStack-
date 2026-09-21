package com.inkstack.common;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** 与 Node 的 createHash('sha256').update(s).digest('hex') 同结果：小写 hex，输入按 UTF-8。 */
public final class Hex {

  private Hex() {}

  public static String sha256Hex(String input) {
    return encode(sha256(input.getBytes(StandardCharsets.UTF_8)));
  }

  public static byte[] sha256(byte[] input) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(input);
    } catch (Exception e) {
      throw new IllegalStateException("SHA-256 不可用", e);
    }
  }

  public static String encode(byte[] bytes) {
    StringBuilder sb = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
    }
    return sb.toString();
  }
}
