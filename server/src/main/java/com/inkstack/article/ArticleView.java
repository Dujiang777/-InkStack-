package com.inkstack.article;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.FeedArticle;
import java.util.List;

/**
 * 列表项视图：字段名与取值语义必须和 Node 端 listArticles 返回的对象完全一致，
 * 因为前端与对拍脚本都直接吃这个形状。
 */
public record ArticleView(
    String slug,
    String title,
    String author,
    String authorAvatar,
    Long authorId,
    String summary,
    String coverLabel,
    List<String> tags,
    long readCount,
    long commentCount,
    long agentQaCount,
    String publishedAt,
    String md,
    long likeCount,
    String boostUntil,
    long tipTotal,
    long unlockPrice,
    long discountPrice,
    String discountUntil) {

  /** 列表接口固定不携正文（md 恒为空串），全文只在详情接口按付费墙判定后给出。 */
  public static ArticleView from(FeedArticle row) {
    return new ArticleView(
        row.getSlug(), row.getTitle(), row.getAuthor(), NodeShapes.text(row.getAuthorAvatar()),
        row.getAuthorId(), NodeShapes.text(row.getSummary()), NodeShapes.text(row.getCoverLabel()),
        NodeShapes.tags(row.getTags()), NodeShapes.num(row.getReadCount()),
        NodeShapes.num(row.getCommentCount()), NodeShapes.num(row.getAgentQaCount()),
        NodeShapes.text(row.getPublishedAt()), "", NodeShapes.num(row.getLikeCount()),
        NodeShapes.iso(row.getBoostUntil()), NodeShapes.num(row.getTipTotal()),
        NodeShapes.num(row.getUnlockPrice()), NodeShapes.num(row.getDiscountPrice()),
        NodeShapes.iso(row.getDiscountUntil()));
  }
}
