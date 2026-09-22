package com.inkstack.article;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.common.NodeShapes;
import com.inkstack.entity.ArticleWriteRows;
import com.inkstack.mapper.ArticleWriteMapper;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 创作台的写侧：发布、存草稿、草稿转正、更新重审、撤回、硬删。
 *
 * <p>这里最值钱的一条规则是 <b>slug 撞键要换号重试</b>。中文标题一律生成 {@code bo-日期-1} 这种
 * 兜底 slug，同一时刻并发发布同名文章会算出完全相同的候选；早期实现是"SELECT 判重 → 裸 INSERT"，
 * 两句之间无锁，实测 8 并发 → 7 个 500「发布失败（数据库异常）」，可用户其实已经有一篇落库了，
 * 重试就出重复稿。现在命中唯一键就重新分配后缀并抖动退避。
 */
@Service
public class ArticleWriteService {

  /** 撞键重试上限，与 Node 的 attempt &lt; 8 同。 */
  private static final int SLUG_ATTEMPTS = 8;

  /** 草稿硬删要清的子表：全是代码内常量，配合 mapper 的 ${table} 拼接使用。 */
  private static final List<String> CHILD_TABLES = List.of(
      "article_boosts", "article_tips", "article_likes", "bookmarks",
      "read_history", "comments", "series_items", "article_purchases");

  private static final ObjectMapper JSON = new ObjectMapper();

  private final ArticleWriteMapper db;
  private final TransactionTemplate tx;

  public ArticleWriteService(ArticleWriteMapper db, TransactionTemplate tx) {
    this.db = db;
    this.tx = tx;
  }

  /** 发布结果：草稿分支只回 slug；正式发布的 balance 仅在真的发墨时存在（Node 的 undefined 键不出现在 JSON 里）。 */
  public record Published(String slug, long reward, boolean capped, Long balance) {}

  /**
   * 发布或存草稿。{@code asDraft} 走 status='draft' + review_status='approved'（草稿不入审核流、不发奖励）。
   *
   * @return slug 与是否走了草稿分支
   */
  public String insert(ArticleWriteRows.Row row, boolean asDraft) {
    String tagsJson = json(row.getTags());
    for (int attempt = 0; ; attempt++) {
      String slug = uniqueSlug(row);
      try {
        if (asDraft) {
          db.insertDraft(row, slug, tagsJson);
        } else {
          db.insertPublished(row, slug, tagsJson);
        }
        return slug;
      } catch (DuplicateKeyException taken) {
        if (attempt >= SLUG_ATTEMPTS - 1) {
          throw taken;
        }
        // 抖动退避：并发请求会"同步"地重算出同一个空位，不加抖动就会反复对撞
        backoff(attempt);
      }
    }
  }

  /** Node 的 uniqueSlug：基准 slug 只算一次，被占就在后面追加 -2、-3…… */
  private String uniqueSlug(ArticleWriteRows.Row row) {
    String base = com.inkstack.common.Slugs.make(NodeShapes.text(row.getTitle()), 1);
    String candidate = base;
    for (int i = 2; !db.slugTaken(candidate).isEmpty(); i++) {
      candidate = base + "-" + i;
    }
    return candidate;
  }

  public ArticleWriteRows.Head head(String slug) {
    return db.head(slug);
  }

  public void saveDraft(ArticleWriteRows.Row row, long id) {
    db.saveDraft(row, json(row.getTags()), id);
  }

  public void publishOnly(String reviewStatus, long id) {
    db.publishOnly(reviewStatus, id);
  }

  public void updateAndPublish(ArticleWriteRows.Row row, String reviewStatus, boolean fromDraft, long id) {
    db.updateAndPublish(row, json(row.getTags()), reviewStatus, fromDraft ? 1 : 0, id);
  }

  public List<Long> admins() {
    return db.adminIds();
  }

  /**
   * 撤回：已发布/审核中只置 status='removed'（数据与积分流水都留着），
   * 草稿才是真删——真删必须在一个事务里清完所有子行，否则外键 RESTRICT 会把主行挡下来，
   * 而前面已自动提交的几条 DELETE 又收不回，就成了"稿子还在、点赞却被清空"的部分删除。
   */
  public boolean withdraw(long id, String status) {
    if (!"draft".equals(status)) {
      db.markRemoved(id);
      return false;
    }
    tx.executeWithoutResult(txStatus -> {
      for (String table : CHILD_TABLES) {
        db.deleteChildren(table, id);
      }
      db.deleteArticle(id);
    });
    return true;
  }

  private static String json(List<String> tags) {
    try {
      return JSON.writeValueAsString(tags == null ? List.of() : tags);
    } catch (JsonProcessingException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  private static void backoff(int attempt) {
    long wait = 5L + ThreadLocalRandom.current().nextInt(20) * (attempt + 1L);
    try {
      Thread.sleep(wait);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}
