package com.inkstack.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** 双轨期唯一的请求归属标记：浏览器与 Next 中间层都走同域，靠这个头判断请求落在哪套后端。 */
@Component
public class BackendTagFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    response.setHeader("X-Backend", "inkstack-java");
    chain.doFilter(request, response);
  }
}
