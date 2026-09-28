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

  /**
   * 书房里的"开个专栏"建议一条。题名 = 标签 + 轮换后缀后截 60，hint 里的数字是该标签的篇数——
   * 两句文案的分隔符「」与空格都是前端直接显示的，改动一个字符用户就能看到。
   */
  public record Suggestion(String title, String hint) {

    public static Suggestion of(String tag, long count, String suffix) {
      return new Suggestion(NodeShapes.slice(tag + suffix, 60), "已有 " + count + " 篇「" + tag + "」文章可以成柜");
    }
  }
}
