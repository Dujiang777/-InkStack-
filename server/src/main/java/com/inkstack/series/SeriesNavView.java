package com.inkstack.series;

/** 文章页专栏导航：所属专栏 + 第几篇 / 共几篇 + 上下篇。 */
public record SeriesNavView(
    long id,
    String title,
    int position,
    int total,
    Ref prev,
    Ref next) {

  public record Ref(String slug, String title) {}
}
