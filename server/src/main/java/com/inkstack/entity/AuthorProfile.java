package com.inkstack.entity;

import lombok.Data;

/** 作者主页头部行（users + 三个针对公开文章的计数子查询）。 */
@Data
public class AuthorProfile {

  private Long id;
  private String nickname;
  private String avatarText;
  private String avatarTone;
  private String avatarShape;
  private String bio;
  private String createdAt;
  private Long articles;
  private Long likes;
  private Long readTotal;
}
