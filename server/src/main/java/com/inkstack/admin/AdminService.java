package com.inkstack.admin;

import com.inkstack.common.NodeDates;
import com.inkstack.common.NodeShapes;
import com.inkstack.entity.AdminRows;
import com.inkstack.mapper.AdminMapper;
import com.inkstack.mapper.PointLedgerMapper;
import com.inkstack.mapper.UserMapper;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 运营台的四条写链路：内容管理、评论删除、举报处理、用户管理。
 *
 * <p>全部动作都要落 {@code admin_actions} 审计日志。日志写入失败是静默的（与 Node 同）——
 * 但业务动作本身失败必须回报，不能用"记了日志"来掩盖"没改成"。
 */
@Service
public class AdminService {

  /** 六种常规动作的 SET 片段，与服务层白名单同源；键名就是接口接受的 action。 */
  private static final Map<String, String> ACTION_SQL = Map.of(
      "publish", "status = 'published'",
      "unpublish", "status = 'removed'",
      "pin", "pinned = 1 - pinned",
      "unpin", "pinned = 0",
      "feature", "featured = 1 - featured",
      "unfeature", "featured = 0");

  /** 运营改价的折扣窗：与 Node 一样写死 7 天，落库为 UTC 串。 */
  private static final int PRICE_DISCOUNT_DAYS = 7;

  private final AdminMapper db;
  private final UserMapper users;
  private final PointLedgerMapper ledger;
  private final TransactionTemplate tx;

  public AdminService(
      AdminMapper db, UserMapper users, PointLedgerMapper ledger, TransactionTemplate tx) {
    this.db = db;
    this.users = users;
    this.ledger = ledger;
    this.tx = tx;
  }

  /** ok=false 时 error 就是要回给运营的文案（接口一律按 400 回）。工厂名不能与分量 ok() 同签名。 */
  public record Result(boolean ok, String error) {

    static Result passed() {
      return new Result(true, null);
    }

    static Result fail(String error) {
      return new Result(false, error);
    }
  }

  /** 审核结果额外带回作者 id（0 = 没有作者可通知，Node 那边是 undefined）。 */
  public record Review(boolean ok, String error, long authorId) {}

  /** 删评论带回真正删掉的行数（含一级回复），审计日志要写这个数。 */
  public record Removed(boolean ok, String error, Integer removed) {}

  public Result setArticle(String slug, String action) {
    String sql = ACTION_SQL.get(action);
    if (sql == null) {
      return Result.fail("未知操作");
    }
    // 下架顺带取消置顶/精选，否则会留下"已下架却还占着首页置顶位"的僵尸状态
    String extra = "unpublish".equals(action) ? ", pinned = 0, featured = 0" : "";
    return db.setArticle(sql + extra, slug) > 0 ? Result.passed() : Result.fail("文章不存在");
  }

  public Review review(String slug, boolean approve, String note) {
    String trimmed = NodeShapes.jsTrim(NodeShapes.text(note));
    if (!approve && trimmed.isEmpty()) {
      return new Review(false, "驳回必须填写原因", 0L);
    }
    int affected = db.reviewArticle(approve ? "approved" : "rejected",
        approve ? null : NodeShapes.slice(trimmed, 255), slug);
    if (affected == 0) {
      return new Review(false, "文章不存在", 0L);
    }
    Long author = db.authorOf(slug);
    return new Review(true, null, NodeShapes.num(author));
  }

  public Result setPrice(String slug, double rawUnlock, double rawDiscount) {
    long up = (long) Math.floor(Double.isNaN(rawUnlock) ? 0d : rawUnlock);
    long dp = (long) Math.floor(Double.isNaN(rawDiscount) ? 0d : rawDiscount);
    if (up < 0 || up > 100_000 || dp < 0 || dp > up) {
      return Result.fail("价格须为 0–100000，且折扣价 ≤ 解锁价");
    }
    String until = dp > 0
        ? NodeDates.toSqlUtc(Instant.now().plus(PRICE_DISCOUNT_DAYS, ChronoUnit.DAYS))
        : null;
    return db.setPrice(up, dp, until, slug) > 0 ? Result.passed() : Result.fail("文章不存在");
  }

  /** 删一条评论连带它的一级回复，并把文章评论数按实际删除数扣回（GREATEST 兜住不减成负）。 */
  public Removed deleteComment(long commentId) {
    Removed outcome = tx.execute(status -> {
      AdminRows.CommentOwner owner = db.lockComment(commentId);
      if (owner == null) {
        status.setRollbackOnly();
        return new Removed(false, "评论不存在", null);
      }
      int removed = db.deleteCommentTree(commentId);
      db.reclaimCommentCount(NodeShapes.num(owner.getArticleId()), removed);
      return new Removed(true, null, removed);
    });
    return outcome == null ? new Removed(false, "删除失败", null) : outcome;
  }

  /**
   * 举报处理。删除内容分文章（置 removed）与评论（真删）两条路，
   * 三种处置都要把举报行推到终态，否则它会一直留在队列里被第二次处理。
   *
   * <p>{@code note} 为 null 时用该处置的默认说明（Node 是 {@code note ?? "…"}，
   * 所以空串<b>不</b>触发默认——传空串就是真的想留空）。
   */
  public Result handleReport(long reportId, String handle, String note) {
    Result outcome = tx.execute(status -> {
      AdminRows.Report rep = db.lockReport(reportId);
      if (rep == null) {
        status.setRollbackOnly();
        return Result.fail("举报不存在");
      }
      switch (handle) {
        case "delete_content" -> {
          if ("article".equals(rep.getTargetType())) {
            db.removeArticleById(NodeShapes.num(rep.getTargetId()));
          } else {
            db.deleteCommentById(NodeShapes.num(rep.getTargetId()));
          }
          db.resolveReport(NodeShapes.slice(orDefault(note, "已删除被举报内容"), 255), reportId);
        }
        case "keep" -> db.resolveReport(NodeShapes.slice(orDefault(note, "核查后保留内容"), 255), reportId);
        default -> db.dismissReport(NodeShapes.slice(orDefault(note, "无效举报"), 255), reportId);
      }
      return Result.passed();
    });
    return outcome == null ? Result.fail("处理失败（数据库异常）") : outcome;
  }

  private static String orDefault(String value, String fallback) {
    return value == null ? fallback : value;
  }

  /**
   * 用户管理。封禁与角色变更都不许碰管理团队（条件写在 SQL 里，由 affectedRows 说话），
   * 积分增减走"锁行 → 算真实变化 → 绝对值写回 + 同事务流水"，账面与余额恒等。
   */
  public Result setUser(long userId, String action, double rawAmount, String newRole) {
    switch (action) {
      case "ban" -> {
        return db.ban(userId) > 0 ? Result.passed() : Result.fail("用户不存在或为管理团队");
      }
      case "unban" -> {
        return db.unban(userId) > 0 ? Result.passed() : Result.fail("用户不存在");
      }
      case "setRole" -> {
        String target = NodeShapes.jsTrim(NodeShapes.text(newRole));
        if (!target.equals("reader") && !target.equals("author") && !target.equals("admin")) {
          return Result.fail("目标角色须为 reader / author / admin");
        }
        String current = NodeShapes.text(db.roleOf(userId));
        if (current.isEmpty()) {
          return Result.fail("用户不存在");
        }
        if ("developer".equals(current)) {
          return Result.fail("开发者身份不可在此变更");
        }
        return db.setRole(target, userId) > 0 ? Result.passed() : Result.fail("角色变更失败");
      }
      default -> {
        return adjustPoints(userId, action, rawAmount);
      }
    }
  }

  private Result adjustPoints(long userId, String action, double rawAmount) {
    long amt = (long) Math.floor(Double.isNaN(rawAmount) ? 0d : rawAmount);
    if (amt <= 0 || amt > 100_000) {
      return Result.fail("点墨数量须为 1–100000");
    }
    boolean grant = "grant".equals(action);
    long delta = grant ? amt : -amt;
    Result outcome = tx.execute(status -> {
      Long locked = users.lockBalance(userId);
      if (locked == null) {
        status.setRollbackOnly();
        return Result.fail("用户不存在");
      }
      long before = locked;
      long after = Math.max(0L, before + delta);
      long applied = after - before;
      if (applied == 0) {
        status.setRollbackOnly();
        return Result.fail("该用户余额已为 0，无可扣回的点墨");
      }
      users.setBalanceAbsolute(userId, after);
      ledger.insert(userId, applied, grant
          ? "运营发放 " + amt + " 点墨"
          : "运营扣回 " + (-applied) + " 点墨"
              + (applied != delta ? "（请求 " + amt + "，余额不足按实际扣减）" : ""));
      return Result.passed();
    });
    return outcome == null ? Result.fail("点墨调整失败，请稍后再试") : outcome;
  }

  /** 审计日志：失败静默，但不能让"日志没记上"把已经成功的操作报成失败。 */
  public void log(long adminId, String action, String targetType, Object targetId, String detail) {
    try {
      db.logAction(adminId,
          NodeShapes.slice(action, 64),
          NodeShapes.slice(targetType, 32),
          NodeShapes.slice(String.valueOf(targetId), 64),
          detail == null ? null : NodeShapes.slice(detail, 500));
    } catch (RuntimeException ignored) {
      // 与 Node 一致：审计写不进去不改操作结果
    }
  }

  public AdminRows.Raw raw(String slug) {
    return db.raw(slug);
  }
}
