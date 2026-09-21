package com.inkstack.session;

import com.fasterxml.jackson.annotation.JsonIgnore;

/** 登录态用户，字段名即 Node SessionUser 的响应字段名（points 而非 pointsBalance）。 */
public record SessionUser(long id, String nickname, String email, String role, long points) {

  /** 必须 JsonIgnore：否则 Jackson 把它当属性序列化，/me 会多出一个 Node 侧不存在的 staff 键。 */
  @JsonIgnore
  public boolean isStaff() {
    return "admin".equals(role) || "developer".equals(role);
  }
}
