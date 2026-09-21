package com.inkstack.article;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.AuthorArticle;
import java.util.List;

/** 作者主页列表项：与 TagArticleView 的差别就是定价三列进、authorId 出（照抄 Node 两个函数的返回对象）。 */
public record AuthorArticleView(
    String slug,
    String title,
    String author,
    String authorAvatar,
    String summary,
    String coverLabel,
    List<String> tags,
    long readCount,
    long commentCount,
    long agentQaCount,
    String publishedAt,
    String md,
    long likeCount,
    long tipTotal,
    long unlockPrice,
    long discountPrice,
    String discountUntil) {

  public static AuthorArticleView from(AuthorArticle row) {
    return new AuthorArticleView(
        row.getSlug(), row.getTitle(), row.getAuthor(), NodeShapes.text(row.getAuthorAvatar()),
        NodeShapes.text(row.getSummary()), NodeShapes.text(row.getCoverLabel()),
        NodeShapes.tags(row.getTags()), NodeShapes.num(row.getReadCount()),
        NodeShapes.num(row.getCommentCount()), NodeShapes.num(row.getAgentQaCount()),
        NodeShapes.text(row.getPublishedAt()), "", NodeShapes.num(row.getLikeCount()),
        NodeShapes.num(row.getTipTotal()), NodeShapes.num(row.getUnlockPrice()),
        NodeShapes.num(row.getDiscountPrice()), NodeShapes.iso(row.getDiscountUntil()));
  }
}
