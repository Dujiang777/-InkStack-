package com.inkstack.series;

import java.util.List;

/** 书房管理器里的一个专栏及其篇目。 */
public record MySeriesView(long id, String title, String description, List<Ref> items) {

  public record Ref(String slug, String title) {}
}
