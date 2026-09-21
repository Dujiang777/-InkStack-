package com.inkstack.auth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** 基准值来自 Node 的 crypto.scryptSync(password, saltHex, 64)，参数 N=16384/r=8/p=1。 */
class PasswordHasherTest {

  private static final String PASSWORD = "Test1234!";
  private static final String NODE_SALT = "9273851c74a479efedb1d9cf7799b8d1";
  private static final String NODE_HASH =
      "7e91dd033cf323a2e9923cc64ee0e947702f65be04099d10e9109b2595884177"
          + "995709e724e71b3626d9270f3731025002bafd94dff26d39ac81998d987c5015";

  @Test
  void verifiesPasswordHashedByNode() {
    assertThat(PasswordHasher.verify(PASSWORD, NODE_SALT + ":" + NODE_HASH)).isTrue();
    assertThat(PasswordHasher.verify(PASSWORD.toLowerCase(), NODE_SALT + ":" + NODE_HASH)).isFalse();
  }

  @Test
  void producesNodeCompatibleStoredFormat() {
    String stored = PasswordHasher.hash(PASSWORD);
    assertThat(stored).matches("[0-9a-f]{32}:[0-9a-f]{128}");
    assertThat(PasswordHasher.verify(PASSWORD, stored)).isTrue();
  }

  @Test
  void rejectsMalformedStoredValue() {
    assertThat(PasswordHasher.verify(PASSWORD, null)).isFalse();
    assertThat(PasswordHasher.verify(PASSWORD, "no-colon")).isFalse();
    assertThat(PasswordHasher.verify(PASSWORD, ":abc")).isFalse();
    assertThat(PasswordHasher.verify(PASSWORD, "abc:")).isFalse();
    assertThat(PasswordHasher.verify(PASSWORD, NODE_SALT + ":" + "zz")).isFalse();
  }
}
