package com.inkstack.session;

/**
 * ink_session 载荷。
 *
 * <p>字段顺序必须是 sid,uid,exp：HMAC 覆盖的是这段 JSON 的字符串本身，顺序或空格一变，
 * Node 侧就验不过签名。exp 是毫秒级 epoch，与 Node 的 Date.now() 同量纲。
 */
public record SessionPayload(String sid, long uid, long exp) {}
