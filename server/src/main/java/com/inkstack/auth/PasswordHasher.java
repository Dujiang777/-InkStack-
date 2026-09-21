package com.inkstack.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.bouncycastle.crypto.generators.SCrypt;

/**
 * users.password_hash 的格式与算法，必须与 Node 的 crypto.scryptSync 完全一致，
 * 否则双轨期一侧改密会让另一侧登不进去。
 *
 * <p>存储格式 {@code 32位hex盐 : 128位hex派生密钥}；scrypt 参数取 Node 默认值
 * N=16384 / r=8 / p=1 / keylen=64。最坑的一点：喂给 scrypt 的盐是<b>那串 32 个 hex
 * 字符的 UTF-8 字节</b>，不是解码后的 16 字节——按 16 字节算会得出完全不同的哈希。
 */
public final class PasswordHasher {

  private static final int N = 16384;
  private static final int R = 8;
  private static final int P = 1;
  private static final int KEY_LEN = 64;
  private static final int SALT_BYTES = 16;

  private static final SecureRandom RANDOM = new SecureRandom();

  private PasswordHasher() {}

  public static String hash(String password) {
    byte[] raw = new byte[SALT_BYTES];
    RANDOM.nextBytes(raw);
    String saltHex = toHex(raw);
    return saltHex + ":" + toHex(derive(password, saltHex));
  }

  public static boolean verify(String password, String stored) {
    if (stored == null) {
      return false;
    }
    int colon = stored.indexOf(':');
    if (colon <= 0 || colon == stored.length() - 1) {
      return false;
    }
    String saltHex = stored.substring(0, colon);
    String expected = stored.substring(colon + 1);
    try {
      return MessageDigest.isEqual(derive(password, saltHex), fromHex(expected));
    } catch (RuntimeException malformed) {
      return false;
    }
  }

  private static byte[] derive(String password, String saltHex) {
    return SCrypt.generate(
        password.getBytes(StandardCharsets.UTF_8),
        saltHex.getBytes(StandardCharsets.UTF_8),
        N, R, P, KEY_LEN);
  }

  private static String toHex(byte[] bytes) {
    StringBuilder sb = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
    }
    return sb.toString();
  }

  private static byte[] fromHex(String hex) {
    if (hex.length() % 2 != 0) {
      throw new IllegalArgumentException("hex 长度非法");
    }
    byte[] out = new byte[hex.length() / 2];
    for (int i = 0; i < out.length; i++) {
      out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
}
