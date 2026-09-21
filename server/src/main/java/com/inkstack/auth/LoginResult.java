package com.inkstack.auth;

/** 登录的四种终局，键集与 Node 侧四条 return 一一对应。 */
public sealed interface LoginResult {

  record Success(long id, String nickname) implements LoginResult {}

  record Need2fa(String email) implements LoginResult {}

  record Denied(String error, boolean need2fa) implements LoginResult {}

  record Locked(String error, long retryAfterSec) implements LoginResult {}
}
