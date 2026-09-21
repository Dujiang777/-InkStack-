package com.inkstack.entity;

import lombok.Data;

/** 专栏篇目行：上下篇导航与书房管理器共用。 */
@Data
public class SeriesItem {

  private Long seriesId;
  private Long articleId;
  private String slug;
  private String title;
}
