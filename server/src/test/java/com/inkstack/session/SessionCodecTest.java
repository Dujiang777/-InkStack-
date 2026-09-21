package com.inkstack.session;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Base64;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/**
 * 基准向量由 Node 的 lib/auth.ts 实现真实签发（crypto.createHmac + Buffer base64url），
 * 不是本地造的：换栈互通要证明的就是"Java 能验 Node 签的 Cookie"。
 */
class SessionCodecTest {

  private static final String SECRET = "inkstack-junit-secret-not-for-prod";
  private static final String NODE_TOKEN =
      "eyJzaWQiOiI2NjdkYzBlN2U0ZTExZDAwZmFhOWEwODlkYWE4ZjFjOGJmY2MiLCJ1aWQiOjksImV4cCI6NDEwMjQ0NDgwMDAwMH0"
          + ".C7h7Hu6zOicKqDhV7ksbsIIcQ7TVVKIk9vX1nW00SZw";
  private static final String NODE_SID = "667dc0e7e4e11d00faa9a089daa8f1c8bfcc";
  private static final String EXPIRED_TOKEN =
      "eyJzaWQiOiI2YzY1NzIyZTExNjQwZGJlYzgzOTU3MWNmNjdhODUzMTJmNDgiLCJ1aWQiOjksImV4cCI6MTAwMDAwMDAwMDAwMH0"
          + ".27Ipr5xGkEc15cPepSGsy5cyJyy0KInKT5d-yL_7nzI";

  private SessionCodec codec(String siteUrl) {
    return new SessionCodec(SECRET, siteUrl, "0");
  }

  @Test
  void verifiesTokenSignedByNode() {
    SessionCodec codec = codec("http://localhost:3100");
    assertThat(codec.verify(NODE_TOKEN)).get().satisfies(p -> {
      assertThat(p.sid()).isEqualTo(NODE_SID);
      assertThat(p.uid()).isEqualTo(9L);
      assertThat(p.exp()).isEqualTo(4102444800000L);
    });
  }

  @Test
  void rejectsExpiredAndTampered() {
    SessionCodec codec = codec("http://localhost:3100");
    assertThat(codec.verify(EXPIRED_TOKEN)).isEmpty();
    assertThat(codec.verify(NODE_TOKEN.substring(0, NODE_TOKEN.length() - 1) + "b")).isEmpty();
    assertThat(codec.verify(NODE_TOKEN.substring(0, NODE_TOKEN.indexOf('.')))).isEmpty();
    assertThat(codec.verify("")).isEmpty();
    assertThat(codec.verify(null)).isEmpty();
  }

  @Test
  void issuesPayloadByteIdenticalToNodeSerialization() {
    String token = codec("http://localhost:3100").issue(42L).token();
    String payload = new String(
        Base64.getUrlDecoder().decode(token.substring(0, token.indexOf('.'))),
        StandardCharsets.UTF_8);
    // Node 用 JSON.stringify 且键序为 sid,uid,exp，无任何空格；签名覆盖这段字符串本身。
    assertThat(payload).matches("\\{\"sid\":\"[0-9a-f]{36}\",\"uid\":42,\"exp\":\\d{13}\\}");
  }

  @Test
  void roundTripsOwnToken() {
    SessionCodec codec = codec("http://localhost:3100");
    SessionCodec.Issued issued = codec.issue(7L);
    assertThat(issued.sid()).hasSize(36);
    assertThat(codec.verify(issued.token())).get().satisfies(p -> {
      assertThat(p.uid()).isEqualTo(7L);
      assertThat(p.sid()).isEqualTo(issued.sid());
    });
  }

  @Test
  void secureFlagFollowsSiteUrlProtocol() {
    assertThat(codec("http://139.199.88.15").cookieSecure()).isFalse();
    assertThat(codec("https://inkstack.example").cookieSecure()).isTrue();
    assertThat(new SessionCodec(SECRET, "https://x", "1").cookieSecure()).isFalse();
  }
}
