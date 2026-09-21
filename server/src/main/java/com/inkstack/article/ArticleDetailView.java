package com.inkstack.article;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.ArticleDetail;
import java.util.List;

/** 详情视图，字段集合与顺序对齐 lib/data.ts getArticle 的返回对象。 */
public record ArticleDetailView(
    String slug,
    String title,
    String author,
    String authorAvatar,
    String authorTone,
    String authorShape,
    String summary,
    String coverLabel,
    List<String> tags,
    long readCount,
    long commentCount,
    long agentQaCount,
    String publishedAt,
    String md,
    Long authorId,
    long likeCount,
    String reviewStatus,
    String reviewNote,
    boolean viewerLiked,
    boolean viewerUnlocked,
    long unlockPrice,
    long discountPrice,
    String discountUntil,
    long unlockCount,
    String boostUntil,
    long tipTotal) {

  public static ArticleDetailView from(ArticleDetail row, String md) {
    return new ArticleDetailView(
        row.getSlug(), row.getTitle(), row.getAuthor(), NodeShapes.text(row.getAuthorAvatar()),
        NodeShapes.text(row.getAuthorTone()), NodeShapes.text(row.getAuthorShape()),
        NodeShapes.text(row.getSummary()), NodeShapes.text(row.getCoverLabel()),
        NodeShapes.tags(row.getTags()), NodeShapes.num(row.getReadCount()),
        NodeShapes.num(row.getCommentCount()), NodeShapes.num(row.getAgentQaCount()),
        NodeShapes.text(row.getPublishedAt()), NodeShapes.text(md), row.getAuthorId(),
        NodeShapes.num(row.getLikeCount()),
        row.getReviewStatus() == null ? "approved" : row.getReviewStatus(),
        row.getReviewNote(), NodeShapes.flag(row.getViewerLiked()),
        NodeShapes.flag(row.getViewerUnlocked()), NodeShapes.num(row.getUnlockPrice()),
        NodeShapes.num(row.getDiscountPrice()), NodeShapes.iso(row.getDiscountUntil()),
        NodeShapes.num(row.getUnlockCount()), NodeShapes.iso(row.getBoostUntil()),
        NodeShapes.num(row.getTipTotal()));
  }
}
