package com.inkstack.series;

import com.inkstack.common.NodeShapes;
import com.inkstack.common.Pricing;
import com.inkstack.entity.SeriesHead;
import com.inkstack.entity.SeriesItem;
import com.inkstack.entity.SeriesRows;
import com.inkstack.mapper.SeriesMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/** 专栏读侧：文章页上下篇导航 + 书房管理器。 */
@Service
public class SeriesService {

  private final SeriesMapper series;

  public SeriesService(SeriesMapper series) {
    this.series = series;
  }

  /**
   * 文章页的「本文所属专栏 · 上/下篇」。
   *
   * <p>position 与 total 取的是**已发布且过审**篇目里的下标，不是 series_items.position 原值——
   * 柜子里混着草稿时两者并不相等，Node 就是按前者展示的。文章不在任何公开篇目里则返回 null。
   */
  public SeriesNavView navFor(String slug) {
    SeriesItem belonging = series.seriesOfArticle(slug);
    if (belonging == null) {
      return null;
    }
    List<SeriesItem> items = series.publishedItems(belonging.getSeriesId());
    Long selfId = series.articleIdOfSlug(slug);
    if (selfId == null) {
      return null;
    }
    int idx = -1;
    for (int i = 0; i < items.size(); i++) {
      if (selfId.equals(items.get(i).getArticleId())) {
        idx = i;
        break;
      }
    }
    if (idx == -1) {
      return null;
    }
    return new SeriesNavView(
        belonging.getSeriesId(), belonging.getTitle(), idx + 1, items.size(),
        refAt(items, idx - 1), refAt(items, idx + 1));
  }

  /** 书房管理器：我的专栏与各自篇目（含未发布，便于编辑）。无专栏时返回空列表。 */
  public List<MySeriesView> mine(long authorId) {
    List<SeriesHead> heads = series.listMine(authorId);
    if (heads.isEmpty()) {
      return List.of();
    }
    Map<Long, List<MySeriesView.Ref>> grouped = new LinkedHashMap<>();
    for (SeriesHead head : heads) {
      grouped.put(head.getId(), new ArrayList<>());
    }
    for (SeriesItem item : series.itemsOf(List.copyOf(grouped.keySet()))) {
      List<MySeriesView.Ref> bucket = grouped.get(item.getSeriesId());
      if (bucket != null) {
        bucket.add(new MySeriesView.Ref(item.getSlug(), item.getTitle()));
      }
    }
    return heads.stream()
        .map(h -> new MySeriesView(
            h.getId(), h.getTitle(), h.getDescription() == null ? "" : h.getDescription(),
            grouped.getOrDefault(h.getId(), List.of())))
        .toList();
  }

  private static SeriesNavView.Ref refAt(List<SeriesItem> items, int i) {
    if (i < 0 || i >= items.size()) {
      return null;
    }
    SeriesItem item = items.get(i);
    return new SeriesNavView.Ref(item.getSlug(), item.getTitle());
  }

  /** 合集架：全站或某作者的专栏卡。authorId 为 null 时不加 WHERE（与 Node 同一分支）。 */
  public List<SeriesViews.Card> cards(Long authorId, int limit) {
    return series.cards(authorId, limit).stream().map(SeriesViews.Card::from).toList();
  }

  /**
   * 专栏落地页。打包价、待解锁合计、付费篇数都在这一次算清，Node 侧不再二次计算。
   *
   * <p>{@code paidCount} 数的是<b>折后</b>价 &gt; 0 的篇目，{@code fullPrice} 只累加
   * "当前这个人还没解锁"的篇目——两个口径都跟 viewer 有关，不是专栏的固有属性。
   */
  public SeriesViews.Detail detail(long id, Long viewerId) {
    SeriesRows.Head head = series.detailHead(id);
    if (head == null) {
      return null;
    }
    List<SeriesViews.Item> items = series.detailItems(id, viewerId).stream()
        .map(row -> itemOf(row, viewerId)).toList();
    long fullPrice = items.stream().filter(SeriesViews.Item::lockedForViewer)
        .mapToLong(SeriesViews.Item::unlockPrice).sum();
    long bundle = NodeShapes.num(head.getBundlePrice());
    boolean purchased = viewerId != null
        && series.bundlePurchasedBy(id, viewerId) != null;
    SeriesRows.Sold sold = series.soldStats(id);
    return new SeriesViews.Detail(
        head.getId(), head.getTitle(), NodeShapes.text(head.getDescription()), head.getAuthor(),
        head.getAuthorAvatar() == null ? "墨" : head.getAuthorAvatar(), head.getAuthorId(), items,
        bundle > 0 ? bundle : null, purchased, fullPrice,
        items.stream().filter(x -> x.unlockPrice() > 0).count(),
        sold == null ? 0L : NodeShapes.num(sold.getUnlocked()));
  }

  private static SeriesViews.Item itemOf(SeriesRows.Item row, Long viewerId) {
    long price = Pricing.unlockPrice(NodeShapes.num(row.getUnlockPrice()),
        NodeShapes.num(row.getDiscountPrice()), row.getDiscountUntil());
    boolean own = viewerId != null && viewerId.equals(row.getAuthorId());
    boolean locked = price > 0 && !own && !NodeShapes.flag(row.getViewerUnlocked());
    return new SeriesViews.Item(row.getSlug(), row.getTitle(), NodeShapes.num(row.getReadCount()),
        NodeShapes.day(row.getPublishedAt()), price, locked);
  }
}
