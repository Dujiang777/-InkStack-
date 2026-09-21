package com.inkstack.entity;

import lombok.Data;

/** 评论列表原始行，列别名与 Node listComments 的 SQL 一致。 */
@Data
public class CommentRow {

  private Long id;
  private String nickname;
  private String content;
  private Long parentId;
  private String parentAuthor;
  private String createdAt;
  private Long userId;
  private String avatarText;
  private String avatarTone;
  private String avatarShape;
  private Long likes;
  private Integer viewerLiked;
}
