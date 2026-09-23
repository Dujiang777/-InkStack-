package com.inkstack.series;

import com.inkstack.entity.SeriesRows;
import com.inkstack.mapper.SeriesMapper;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 专栏写侧：新建、改元信息、删柜、整体重设篇目。
 *
 * <p>重设篇目是唯一需要事务的一条，而且要<b>先锁柜再动条目</b>。Node 早期把
 * "校验归属 → DELETE → SELECT 篇目 → INSERT" 四条各自自动提交的语句摊开写，
 * 前端双击保存时两个请求都把 DELETE 提交了、后一个的 INSERT 撞主键，
 * 实测 12 并发里 9 个抛错，最坏的一种是删完没插回去——柜子直接空了且不回滚。
 */
@Service
public class SeriesWriteService {

  private final SeriesMapper db;
  private final TransactionTemplate tx;

  public SeriesWriteService(SeriesMapper db, TransactionTemplate tx) {
    this.db = db;
    this.tx = tx;
  }

  /** 建柜后的自增 id；失败返回 {@code null}，由接口层回 500。 */
  public Long create(long authorId, String title, String description) {
    SeriesRows.New row = new SeriesRows.New();
    row.setAuthorId(authorId);
    row.setTitle(title);
    row.setDescription(description);
    return db.insertSeries(row) > 0 && row.getId() != null ? row.getId() : null;
  }

  /** 三个开关对应"这次请求带了哪几个字段"，没带的列一律保持原值。 */
  public boolean updateMeta(
      long id, long authorId,
      boolean setTitle, String title,
      boolean setDescription, String description,
      boolean setBundlePrice, Integer bundlePrice) {
    if (!setTitle && !setDescription && !setBundlePrice) {
      // Node 同样在 sets 为空时直接返回 true：一个字段都没带，没什么可失败
      return true;
    }
    return db.updateMeta(id, authorId,
        setTitle, title == null ? "" : title,
        setDescription, description == null ? "" : description,
        setBundlePrice, bundlePrice) > 0;
  }

  public boolean delete(long id, long authorId) {
    return db.deleteOwned(id, authorId) > 0;
  }

  /**
   * 整体重设篇目。返回 false 的三种情形（柜不是你的、篇目有重复、夹带别人的稿）
   * 在接口层合并成同一条文案——Node 就是 {@code Promise<boolean>}，不区分失败原因，
   * 而区分原因会把"这篇不是你的"这种信息泄露给探测者。
   */
  public boolean setItems(long id, long authorId, List<String> slugs) {
    if (new HashSet<>(slugs).size() != slugs.size()) {
      return false;
    }
    Boolean done = tx.execute(status -> {
      if (db.lockOwned(id, authorId) == null) {
        status.setRollbackOnly();
        return false;
      }
      List<SeriesRows.Positioned> items = new ArrayList<>(slugs.size());
      if (!slugs.isEmpty()) {
        List<SeriesRows.SlugId> owned = db.pickOwnPublished(authorId, slugs);
        if (owned.size() != slugs.size()) {
          status.setRollbackOnly();
          return false;
        }
        Map<String, Long> bySlug = new HashMap<>();
        for (SeriesRows.SlugId row : owned) {
          bySlug.put(row.getSlug(), row.getId());
        }
        for (int i = 0; i < slugs.size(); i++) {
          items.add(new SeriesRows.Positioned(bySlug.get(slugs.get(i)), i));
        }
      }
      db.clearItems(id);
      if (!items.isEmpty()) {
        db.insertItems(id, items);
      }
      return true;
    });
    return Boolean.TRUE.equals(done);
  }
}
