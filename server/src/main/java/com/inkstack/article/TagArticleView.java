package com.inkstack.article;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.AuthorArticle;
import java.util.List;

/**
 * 标签页列表项：字段集合严格等于 Node listByTag 的返回对象——不含定价三列，
 * md 恒为空串（列表查询根本不取 md_content）。
 */
public record TagArticleView(
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
    long tipTotal) {

  public static TagArticleView from(AuthorArticle row) {
    return new TagArticleView(
        row.getSlug(), row.getTitle(), row.getAuthor(), NodeShapes.text(row.getAuthorAvatar()),
        row.getAuthorId(), NodeShapes.text(row.getSummary()), NodeShapes.text(row.getCoverLabel()),
        NodeShapes.tags(row.getTags()), NodeShapes.num(row.getReadCount()),
        NodeShapes.num(row.getCommentCount()), NodeShapes.num(row.getAgentQaCount()),
        NodeShapes.text(row.getPublishedAt()), "", NodeShapes.num(row.getLikeCount()),
        NodeShapes.num(row.getTipTotal()));
  }
}
