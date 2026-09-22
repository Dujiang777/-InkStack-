package com.inkstack.entity;

import lombok.Data;

/**
 * 社区互动写链路的原始行（P5a）。与 {@link MoneyRows} 同样的理由独立成类：
 * 写侧只带"判分支要用的最小列集"，多一列就多一处与 Node 漂移的可能。
 */
public final class CommunityRows {

  private CommunityRows() {}

  /**
   * 发表评论：Node 用 INSERT..SELECT 把"文章必须 published"塞进同一条语句，
   * 于是 affectedRows=0 就是"文章不存在或未公开"，不需要先 SELECT 再 INSERT（两句之间的空档
   * 够别人把文章撤下去）。insertId 回读给前端替换占位行。
   */
  @Data
  public static class CommentInsert {
    private Long userId;
    private String guestNickname;
    private Long parentId;
    private String content;
    private String slug;
    private Long id;
  }

  /** 点赞前置读：作者与标题用于发通知。 */
  @Data
  public static class LikeTarget {
    private Long id;
    private Long authorId;
    private String title;
  }

  @Data
  public static class Nickname {
    private String nickname;
  }

  /** 父评论的作者 id：回复通知只发给"人"，游客楼层为 null。 */
  @Data
  public static class ParentUser {
    private Long userId;
  }

  @Data
  public static class Counter {
    private Long n;
  }

  /** 举报锚点：FOR UPDATE 锁住目标行本身，同目标的并发举报在此排队。 */
  @Data
  public static class Anchor {
    private Long id;
  }

  /** 站内信一行，列名与 Node 的 SELECT 别名逐字对齐。 */
  @Data
  public static class Notice {
    private Long id;
    private String type;
    private String title;
    private String body;
    private String link;
    private Long isRead;
    private String createdAt;
  }
}
