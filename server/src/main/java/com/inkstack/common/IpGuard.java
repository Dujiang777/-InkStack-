package com.inkstack.common;

/**
 * 私网 / 环回地址判定，与 {@code app/api/import/route.ts} 同一套规则，且**按字节判而不是按文本前缀判**。
 *
 * <p>按前缀判在这里有一个可利用的绕过：WHATWG 的 URL 解析器会把
 * {@code [::ffff:192.168.101.1]} 规范成 {@code [::ffff:c0a8:6581]}，
 * 于是"取 {@code ::ffff:} 之后的那点字符串再按 IPv4 判"拿到的是一段十六进制而不是点分十进制，
 * 正则不命中就当作公网放行——而操作系统仍然会把它当 IPv4 映射地址连出去（实测 200）。
 * 所以两侧都先解析成字节，再在字节上做同样的前缀规则。
 */
public final class IpGuard {

  private IpGuard() {}

  /** 4 字节 = IPv4，16 字节 = IPv6；其它长度按"不判定为私网"处理（与 Node 的解析失败同侧）。 */
  public static boolean isPrivate(byte[] addr) {
    if (addr == null) {
      return false;
    }
    if (addr.length == 4) {
      return isPrivateV4(addr[0] & 0xFF, addr[1] & 0xFF);
    }
    if (addr.length != 16) {
      return false;
    }
    boolean headZero = true;
    for (int i = 0; i < 10; i++) {
      headZero = headZero && addr[i] == 0;
    }
    if (headZero && (addr[10] & 0xFF) == 0xFF && (addr[11] & 0xFF) == 0xFF) {
      // IPv4 映射地址：按尾四节的 IPv4 规则判
      return isPrivateV4(addr[12] & 0xFF, addr[13] & 0xFF);
    }
    boolean allZero = true;
    boolean loopback = true;
    for (int i = 0; i < 16; i++) {
      int expected = i == 15 ? 1 : 0;
      allZero = allZero && addr[i] == 0;
      loopback = loopback && addr[i] == expected;
    }
    if (allZero || loopback) {
      return true; // :: 与 ::1
    }
    int b0 = addr[0] & 0xFF;
    if (b0 == 0xFE && (addr[1] & 0xFF) >> 4 >= 8 && (addr[1] & 0xFF) >> 4 <= 0xB) {
      return true; // 链路本地 fe80::-febf::
    }
    return b0 == 0xFC || b0 == 0xFD; // ULA
  }

  private static boolean isPrivateV4(int a, int b) {
    if (a == 0 || a == 10 || a == 127) {
      return true; // 本网络 / 内网 / 环回
    }
    if (a == 169 && b == 254) {
      return true; // 链路本地（云厂商元数据常见）
    }
    if (a == 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a == 192 && b == 168) {
      return true;
    }
    return a == 100 && b >= 64 && b <= 127; // CGNAT
  }
}
