package com.inkstack.entity;

import lombok.Data;

/** 关注计数：followers = 谁被关注数，following = 该用户关注了谁。 */
@Data
public class FollowCounts {

  private Long followers;
  private Long following;
}
