package com.inkstack.auth;

/** POST /api/auth/login 请求体；多余字段由 Jackson 忽略，与原实现的宽松解析同行为。 */
public record LoginRequest(String email, String password, String totp) {}
