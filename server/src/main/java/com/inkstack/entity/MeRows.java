package com.inkstack.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** 个人中心各条足迹的原始行集合（一个容器类装下六行小结构，避免为六个查询建六个文件）。 */
public final class MeRows {

  private MeRows() {}

  /** 点赞 / 收藏 / 阅读历史共用的列宽集：各自的查询只填自己那几列。 */
  @Data
  public static class Footprint {
    private String slug;
    private String title;
    private String author;
    private Long readCount;
    private String savedAt;
    private String readAt;
    private Long times;
  }

  @Data
  public static class Comment {
    private Long id;
    private String content;
    private String createdAt;
    private String articleSlug;
    private String articleTitle;
  }

  /** 关注列表里的一个人。 */
  @Data
  public static class Peer {
    private Long id;
    private String nickname;
    private String avatarText;
    private String avatarTone;
    private String avatarShape;
    private String bio;
    private Long articles;
  }

  /** 书房（/study）的一篇：含草稿与下架，故 status / reviewStatus 都在。 */
  @Data
  public static class Article {
    private String slug;
    private String title;
    private String status;
    private String reviewStatus;
    private String reviewNote;
    private Long readCount;
    private Long likeCount;
    private Long commentCount;
    private Long agentQaCount;
    private Long tipTotal;
    private LocalDateTime boostUntil;
    private String updatedAt;
  }

  @Data
  public static class ArticleStats {
    private Long published;
    private Long totalReads;
    private Long totalLikes;
    private Long totalQa;
    private Long drafts;
    private Long tipIncome;
  }
}
