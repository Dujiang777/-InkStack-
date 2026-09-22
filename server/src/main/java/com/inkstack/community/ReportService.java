package com.inkstack.community;

import com.inkstack.entity.CommunityRows;
import com.inkstack.mapper.CommunityMapper;
import java.util.function.Supplier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 举报提交（文章 / 评论共用一条链路）。
 *
 * <p>防重不能写成"先 SELECT 判重再 INSERT"：这两句之间既无锁也无唯一键，实测 20 并发能落十几行
 * （Node 的 v18.0 就是为这个改的）。这里把锚点行本身锁住——同目标的并发举报在 {@code FOR UPDATE}
 * 上排队，前一个提交后后一个才看到 open 举报已存在。
 */
@Service
public class ReportService {

  public enum Code {
    OK,
    NOT_FOUND,
    DUPLICATE,
    DB
  }

  private final CommunityMapper db;
  private final TransactionTemplate tx;

  public ReportService(CommunityMapper db, TransactionTemplate tx) {
    this.db = db;
    this.tx = tx;
  }

  /** 目标必须是已发布文章：未公开的内容本就不该出现在举报队列里。 */
  public Code submitArticle(long reporterId, String slug, String reason) {
    return submit(reporterId, "article", () -> db.lockArticleAnchor(slug), reason);
  }

  /** 评论不限状态：被举报的评论往往正是还在队列里等着处理的那条。 */
  public Code submitComment(long reporterId, long commentId, String reason) {
    return submit(reporterId, "comment", () -> db.lockCommentAnchor(commentId), reason);
  }

  /**
   * 锚点读取用 Supplier 传进事务里执行。
   *
   * <p>这不是风格问题而是正确性问题：写成先把 anchor 查出来再传进 {@code submit}，那句
   * {@code FOR UPDATE} 就跑在事务<b>外</b>——自动提交下它取到锁又立刻放掉，两个并发请求
   * 于是都判"没有未处理举报"，双双插入。闸门里"六路并发只落 1 行"那条断言抓的就是这个。
   */
  private Code submit(
      long reporterId, String targetType, Supplier<CommunityRows.Anchor> anchorRead, String reason) {
    Code outcome =
        tx.execute(
            status -> {
              CommunityRows.Anchor anchor = anchorRead.get();
              if (anchor == null || anchor.getId() == null) {
                status.setRollbackOnly();
                return Code.NOT_FOUND;
              }
              long targetId = anchor.getId();
              if (!db.openReport(reporterId, targetType, targetId).isEmpty()) {
                status.setRollbackOnly();
                return Code.DUPLICATE;
              }
              db.insertReport(reporterId, targetType, targetId, reason);
              return Code.OK;
            });
    return outcome == null ? Code.DB : outcome;
  }
}
