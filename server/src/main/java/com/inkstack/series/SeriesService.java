package com.inkstack.series;

import com.inkstack.entity.SeriesHead;
import com.inkstack.entity.SeriesItem;
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
}
