package com.inkstack.entity;

import lombok.Data;

/** RAG 检索的原始行：只要标题与正文，段落切分在 Java 侧做（与 Node 同位置）。 */
public final class RagRows {

  private RagRows() {}

  @Data
  public static class ArticleMd {
    private String title;
    private String md;
  }
}
