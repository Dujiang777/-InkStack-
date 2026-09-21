package com.inkstack.article;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.SearchRow;
import java.util.List;

/**
 * 搜索结果项。字段顺序与空值语义照抄 Node searchArticles 的返回对象，
 * 其中两处易错：{@code hit} 把空串也归成 null（Node 用的是 falsy 判定而非 == null），
 * {@code publishedAt} 直接取 SQL 的 DATE_FORMAT 串、不再过 dateOnly。
 */
public record SearchView(
    String slug,
    String title,
    String summary,
    String author,
    Long authorId,
    long readCount,
    long likeCount,
    long commentCount,
    String publishedAt,
    String hit,
    List<String> tags,
    long unlockPrice,
    long discountPrice,
    String discountUntil) {

  public static SearchView from(SearchRow row) {
    String hit = row.getHit();
    return new SearchView(
        row.getSlug(), row.getTitle(), NodeShapes.text(row.getSummary()), row.getAuthor(),
        row.getAuthorId(), NodeShapes.num(row.getReadCount()), NodeShapes.num(row.getLikeCount()),
        NodeShapes.num(row.getCommentCount()), NodeShapes.text(row.getPublishedAt()),
        hit == null || hit.isEmpty() ? null : hit, NodeShapes.tags(row.getTags()),
        NodeShapes.num(row.getUnlockPrice()), NodeShapes.num(row.getDiscountPrice()),
        NodeShapes.iso(row.getDiscountUntil()));
  }
}
