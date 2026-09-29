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

  /** 关注动态流的一行：我只看已发布且过审的文章，按发布时间倒序。 */
  @Data
  public static class Feed {
    private String slug;
    private String title;
    private String summary;
    private Long authorId;
    private String author;
    private String authorAvatar;
    private String publishedAt;
    private Long readCount;
    private Long likeCount;
    private Long commentCount;
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

  /**
   * 个人中心的账号资料一行（P7f-1f-a，从 {@code app/me/page.tsx} 那句就地写的 SELECT 搬来）。
   *
   * <p>别名与列的兜底顺序都照原句：{@code IFNULL(bio,'')} 与 {@code COALESCE(avatar_tone,'')}
   * 不是冗余——页面对"没有这一列的值"和"空串"的显示不一样，去掉兜底就会多出一种要判的 null。
   */
  @Data
  public static class Profile {
    private String bio;
    private String avatarText;
    private String avatarTone;
    private String avatarShape;
    private String createdAt;
  }

  /** 墨水账户流水一行。'%m-%d %H:%i' 的格式化留在 SQL 里，与 Node 同处、同格式。 */
  @Data
  public static class Ledger {
    private Long delta;
    private String reason;
    private String at;
  }
}
