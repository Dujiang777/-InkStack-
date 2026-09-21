package com.inkstack.series;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.SeriesRows;
import java.util.List;

/** 合集架与专栏落地页的读视图。 */
public final class SeriesViews {

  private SeriesViews() {}

  public record Card(long id, String title, String description, String author, String authorAvatar,
      long authorId, long articleCount, long totalReads, long soldCount, long bundlePrice,
      String updatedAt) {

    public static Card from(SeriesRows.Card r) {
      return new Card(r.getId(), r.getTitle(), NodeShapes.text(r.getDescription()), r.getAuthor(),
          r.getAuthorAvatar() == null ? "墨" : r.getAuthorAvatar(), r.getAuthorId(),
          NodeShapes.num(r.getArticleCount()), NodeShapes.num(r.getTotalReads()),
          NodeShapes.num(r.getSoldCount()), NodeShapes.num(r.getBundlePrice()),
          NodeShapes.day(r.getUpdatedAt()));
    }
  }

  public record Item(String slug, String title, long readCount, String publishedAt, long unlockPrice,
      boolean lockedForViewer) {}

  public record Detail(long id, String title, String description, String author, String authorAvatar,
      long authorId, List<Item> items, Long bundlePrice, boolean bundlePurchased, long fullPrice,
      long paidCount, long soldCount) {}
}
