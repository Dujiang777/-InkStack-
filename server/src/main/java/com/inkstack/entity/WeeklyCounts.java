package com.inkstack.entity;

import lombok.Data;

/** 每周墨报的五个计数，一条语句取回（Node 侧是五条并发查询，合并成一行不改变口径）。 */
@Data
public class WeeklyCounts {

  private Long newArticles;
  private Long newUsers;
  private Long newComments;
  private Long newSeries;
  private Long tipCount;
  private Long tipInk;
}
