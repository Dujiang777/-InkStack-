package com.inkstack.web;

import com.inkstack.session.SessionUser;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** 注入当前登录用户；未登录注入 null（与原实现 getCurrentUser 返回 null 同语义）。 */
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface Current {}
