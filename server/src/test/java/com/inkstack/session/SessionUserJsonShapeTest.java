package com.inkstack.session;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/**
 * /api/auth/me 的 user 对象键集是前端与对拍脚本共同依赖的契约。
 * 这里防的是"往 record 上加工具方法就被 Jackson 当属性序列化出去"——
 * isStaff() 曾经让 Java 侧比 Node 侧多吐一个 staff 键。
 */
class SessionUserJsonShapeTest {

  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void serializesExactlyTheNodeFieldSet() throws Exception {
    SessionUser user = new SessionUser(9L, "联调员", "test@inkstack.dev", "admin", 27297L);
    assertThat(mapper.writeValueAsString(user))
        .isEqualTo("{\"id\":9,\"nickname\":\"联调员\",\"email\":\"test@inkstack.dev\","
            + "\"role\":\"admin\",\"points\":27297}");
  }

  @Test
  void staffFlagStillWorksForAuthorization() {
    assertThat(new SessionUser(1L, "n", "e", "developer", 0L).isStaff()).isTrue();
    assertThat(new SessionUser(1L, "n", "e", "author", 0L).isStaff()).isFalse();
  }
}
