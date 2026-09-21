package com.inkstack.user;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.MeRows;
import com.inkstack.entity.StatRows;
import java.util.List;

/**
 * 个人中心与创作台的读视图。字段集合逐个照抄 lib/data.ts 对应函数的返回对象，
 * 包括两处容易"顺手统一"的地方： updatedAt 的兜底是 "—"（不是空串）、
 * reviewStatus 的兜底是 "approved"（NULL 视为过审）。
 */
public final class MeViews {

  private MeViews() {}

  public record Peer(long id, String nickname, String avatarText, String avatarTone,
      String avatarShape, String bio, long articles) {

    /** 兜底只针对 null：Node 写的是 {@code ?? "墨"}，空印面照原样输出，不能被当成缺失。 */
    public static Peer from(MeRows.Peer r) {
      return new Peer(r.getId(), r.getNickname(),
          r.getAvatarText() == null ? "墨" : r.getAvatarText(),
          NodeShapes.text(r.getAvatarTone()), NodeShapes.text(r.getAvatarShape()),
          NodeShapes.text(r.getBio()), NodeShapes.num(r.getArticles()));
    }
  }

  public record Like(String slug, String title, String author, long readCount) {

    public static Like from(MeRows.Footprint r) {
      return new Like(r.getSlug(), r.getTitle(), r.getAuthor(), NodeShapes.num(r.getReadCount()));
    }
  }

  public record Bookmark(String slug, String title, String author, long readCount, String savedAt) {

    public static Bookmark from(MeRows.Footprint r) {
      return new Bookmark(r.getSlug(), r.getTitle(), r.getAuthor(),
          NodeShapes.num(r.getReadCount()), NodeShapes.text(r.getSavedAt()));
    }
  }

  public record Read(String slug, String title, String author, long readCount, String readAt, long times) {

    /** Node 是 Number(r.times ?? 1)：只有 NULL 兜 1，真 0 照实输出。 */
    public static Read from(MeRows.Footprint r) {
      return new Read(r.getSlug(), r.getTitle(), r.getAuthor(),
          NodeShapes.num(r.getReadCount()), NodeShapes.text(r.getReadAt()),
          r.getTimes() == null ? 1L : r.getTimes());
    }
  }

  public record Comment(long id, String content, String createdAt, String articleSlug,
      String articleTitle) {

    public static Comment from(MeRows.Comment r) {
      return new Comment(r.getId(), r.getContent(), NodeShapes.text(r.getCreatedAt()),
          r.getArticleSlug(), r.getArticleTitle());
    }
  }

  public record Article(String slug, String title, String status, String reviewStatus,
      String reviewNote, long readCount, long likeCount, long commentCount, long agentQaCount,
      long tipTotal, String boostUntil, String updatedAt) {

    public static Article from(MeRows.Article r) {
      return new Article(r.getSlug(), r.getTitle(), r.getStatus(),
          r.getReviewStatus() == null ? "approved" : r.getReviewStatus(),
          r.getReviewNote() == null || r.getReviewNote().isEmpty() ? null : r.getReviewNote(),
          NodeShapes.num(r.getReadCount()), NodeShapes.num(r.getLikeCount()),
          NodeShapes.num(r.getCommentCount()), NodeShapes.num(r.getAgentQaCount()),
          NodeShapes.num(r.getTipTotal()), NodeShapes.iso(r.getBoostUntil()),
          r.getUpdatedAt() == null ? "—" : r.getUpdatedAt());
    }
  }

  public record Stats(long published, long totalReads, long totalLikes, long tipIncome,
      long totalQa, long drafts) {

    public static Stats from(MeRows.ArticleStats r) {
      if (r == null) {
        return new Stats(0, 0, 0, 0, 0, 0);
      }
      return new Stats(NodeShapes.num(r.getPublished()), NodeShapes.num(r.getTotalReads()),
          NodeShapes.num(r.getTotalLikes()), NodeShapes.num(r.getTipIncome()),
          NodeShapes.num(r.getTotalQa()), NodeShapes.num(r.getDrafts()));
    }
  }

  /** 作品看板一行。Node 把 boostUntil 直接 String(Date) 输出，而所有消费方只取真值，故统一成 ISO。 */
  public record Work(String slug, String title, String status, String publishedAt, long readCount,
      long likeCount, long commentCount, long tipTotal, String boostUntil) {

    public static Work from(StatRows.AuthorStat r) {
      return new Work(r.getSlug(), r.getTitle(),
          r.getStatus() == null ? "published" : r.getStatus(), NodeShapes.text(r.getPublishedAt()),
          NodeShapes.num(r.getReadCount()), NodeShapes.num(r.getLikeCount()),
          NodeShapes.num(r.getCommentCount()), NodeShapes.num(r.getTipTotal()),
          r.getBoostUntil() == null ? null : NodeShapes.iso(r.getBoostUntil()));
    }
  }

  public record Funnel(String slug, String title, long views, long paywallViews, long unlocks,
      long revenue) {

    public static Funnel from(StatRows.Funnel r) {
      return new Funnel(r.getSlug(), r.getTitle(), NodeShapes.num(r.getViews()),
          NodeShapes.num(r.getPaywallViews()), NodeShapes.num(r.getUnlocks()),
          NodeShapes.num(r.getRevenue()));
    }
  }

  public record IncomeRow(String slug, String title, long price, long sales, long earned) {

    public static IncomeRow from(StatRows.UnlockIncome r) {
      return new IncomeRow(r.getSlug(), r.getTitle(), NodeShapes.num(r.getPrice()),
          NodeShapes.num(r.getSales()), NodeShapes.num(r.getEarned()));
    }
  }

  /** 解锁收入汇总：total/sales 由明细在内存里相加（Node 同法），不是再发一条 SUM。 */
  public record UnlockIncome(long total, long sales, List<IncomeRow> byArticle) {

    public static UnlockIncome of(List<StatRows.UnlockIncome> rows) {
      List<IncomeRow> byArticle = rows.stream().map(IncomeRow::from).toList();
      return new UnlockIncome(
          byArticle.stream().mapToLong(IncomeRow::earned).sum(),
          byArticle.stream().mapToLong(IncomeRow::sales).sum(),
          byArticle);
    }
  }
}
