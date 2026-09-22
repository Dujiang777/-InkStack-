package com.inkstack.community;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.CommunityRows;
import com.inkstack.entity.FollowCounts;
import com.inkstack.entity.MoneyRows;
import com.inkstack.mapper.CommunityMapper;
import com.inkstack.mapper.SocialMapper;
import com.inkstack.notify.Notifier;
import com.inkstack.points.PointsService;
import com.inkstack.session.SessionUser;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Objects;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 社区互动的写侧（P5a）：发表评论、文章点赞、收藏、评论点赞、关注。
 *
 * <p>每一步都照 lib/data.ts 的原实现搬，包括它的取舍：评论用 INSERT..SELECT 把"必须已发布"
 * 压进一条语句；点赞在事务里先 FOR UPDATE 锁关系行；收藏用 INSERT IGNORE 判态、撞唯一键再 DELETE，
 * 并对死锁重放（Node 的 v17.9 / v18.0 两轮修补就是这两条链路）。
 */
@Service
public class CommunityService {

  /** 评论奖励：发评人 +1，日上限 3；文章作者 +2，日上限 10。capKey 两栈共用，改名即断档。 */
  private static final long COMMENT_REWARD = 1L;
  private static final long COMMENT_CAP = 3L;
  private static final long RECEIVED_REWARD = 2L;
  private static final long RECEIVED_CAP = 10L;

  /** 撞死锁时的重放次数与退避基线，与 Node 的 attempt&lt;=2 / 5+rnd(25)*(attempt+1) 同式。 */
  private static final int LOCK_ATTEMPTS = 3;

  private static final DateTimeFormatter JS_LOCALE =
      DateTimeFormatter.ofPattern("yyyy-M-d H:mm:ss");

  private final CommunityMapper db;
  private final SocialMapper social;
  private final PointsService points;
  private final Notifier notifier;
  private final TransactionTemplate tx;

  public CommunityService(
      CommunityMapper db, SocialMapper social, PointsService points,
      Notifier notifier, TransactionTemplate tx) {
    this.db = db;
    this.social = social;
    this.points = points;
    this.notifier = notifier;
    this.tx = tx;
  }

  /* ==================== 发表评论 ==================== */

  /** ok=false 时 error 是给读者的文案（Node 一律按 400 返回）。 */
  public record Added(boolean ok, String error, Long id, String createdAt, String nickname) {}

  public Added addComment(
      String slug, String rawNickname, String rawContent, Double rawParentId, SessionUser user) {
    String nickname = displayName(rawNickname, user);
    String content = NodeShapes.jsTrim(rawContent);
    if (content.isEmpty()) {
      return new Added(false, "评论内容不能为空", null, null, nickname);
    }
    if (content.length() > 1000) {
      return new Added(false, "评论最长 1000 字", null, null, nickname);
    }
    Long parentId = null;
    if (rawParentId != null) {
      parentId = db.parentInArticle(rawParentId, slug);
      if (parentId == null) {
        return new Added(false, "要回复的评论不存在或已删除", null, null, nickname);
      }
    }
    CommunityRows.CommentInsert row = new CommunityRows.CommentInsert();
    row.setUserId(user == null ? null : user.id());
    row.setGuestNickname(user == null ? nickname : null);
    row.setParentId(parentId);
    row.setContent(content);
    row.setSlug(slug);
    if (db.addComment(row) == 0) {
      return new Added(false, "文章不存在或未公开，无法评论", null, null, nickname);
    }
    db.bumpCommentCount(slug);
    return new Added(true, null, row.getId(), serverTime(), nickname);
  }

  /** 登录者以账号昵称为准；游客取上报昵称，裁 20 码元后为空则"访客"。 */
  public static String displayName(String rawNickname, SessionUser user) {
    String picked = NodeShapes.jsTrim(user != null ? user.nickname() : NodeShapes.text(rawNickname));
    if (picked.length() > 20) {
      picked = picked.substring(0, 20);
    }
    return picked.isEmpty() ? "访客" : picked;
  }

  /**
   * 服务端时间由 DATE_FORMAT 给；万一取空就退回 Node 那个 fallback 的形态
   * '2026-9-22 15:36:12'——月与日不补零，那是 toLocaleString('zh-CN') 的样子，不是笔误。
   */
  private String serverTime() {
    String fromDb = NodeShapes.text(db.nowText());
    return fromDb.isEmpty() ? LocalDateTime.now().format(JS_LOCALE) : fromDb;
  }

  /** 回复对象的昵称：查不到不影响主流程，回 null 让前端自己兜。 */
  public String parentAuthor(Double parentId) {
    if (parentId == null) {
      return null;
    }
    try {
      CommunityRows.Nickname row = db.nicknameOf(parentId);
      return row == null ? null : row.getNickname();
    } catch (RuntimeException unreadable) {
      return null;
    }
  }

  /**
   * 评论落库后的奖励与通知。整段在 Node 里被 try/catch 包着静默失败——评论已经写进去了，
   * 奖励或站内信出错都不该把它报成失败。
   */
  public Rewards rewardAndNotify(String slug, Double parentId, SessionUser user, String nickname) {
    try {
      MoneyRows.ArticleBrief art = db.articleBySlug(slug);
      if (art == null) {
        return Rewards.none();
      }
      Rewards acc = Rewards.none();
      long authorId = NodeShapes.num(art.getAuthorId());
      if (user != null) {
        if (points.grantCappedReward(user.id(), COMMENT_REWARD, "评论互动", "comment", COMMENT_CAP)
            .granted()) {
          acc = acc.withCommentator(COMMENT_REWARD);
        }
      }
      String who = user == null ? "访客" : nickname;
      if (authorId != 0 && (user == null || authorId != user.id())) {
        if (points.grantCappedReward(
                authorId, RECEIVED_REWARD, "文章被评论", "comment_received", RECEIVED_CAP)
            .granted()) {
          acc = acc.withAuthor(RECEIVED_REWARD);
        }
        notifier.send(authorId, "comment", "文章收到新评论", who + " 参与了讨论", "/article/" + slug);
      }
      if (parentId != null) {
        notifyParent(parentId, user, who, authorId, slug);
      }
      return acc;
    } catch (RuntimeException failed) {
      return Rewards.none();
    }
  }

  /** 回复目标是被评论的人（且不是文章作者）时，单独通知 ta。 */
  private void notifyParent(double parentId, SessionUser user, String who, long authorId, String slug) {
    try {
      CommunityRows.ParentUser parent = db.parentUserOf(parentId);
      Long replied = parent == null ? null : parent.getUserId();
      if (replied != null && (user == null || replied != user.id()) && replied != authorId) {
        notifier.send(replied, "comment", "有人回复了你的评论", who + " 回复了你", "/article/" + slug);
      }
    } catch (RuntimeException unreadable) {
      // 回复通知失败静默
    }
  }

  /** { commentator?: 发评人实发, author?: 作者实发 }；没发放的键不出现（Node 同理）。 */
  public record Rewards(Long commentator, Long author) {

    static Rewards none() {
      return new Rewards(null, null);
    }

    Rewards withCommentator(long amount) {
      return new Rewards(amount, author);
    }

    Rewards withAuthor(long amount) {
      return new Rewards(commentator, amount);
    }
  }

  /* ==================== 文章点赞 ==================== */

  public record Liked(boolean liked, long likeCount, long authorId, String title) {}

  /** 文章不存在或未发布时返回 null → 调用方给 404。 */
  public Liked toggleLike(String slug, SessionUser user) {
    CommunityRows.LikeTarget art = db.likeTarget(slug);
    if (art == null) {
      return null;
    }
    long articleId = NodeShapes.num(art.getId());
    long[] counted = Objects.requireNonNull(
        retryOnLock(() ->
            tx.execute(
                status -> {
                  // 先锁关系行再判态：不锁的话两个并发请求都判"未点赞"，后到者撞主键。
                  boolean exists = !db.lockLike(user.id(), articleId).isEmpty();
                  if (exists) {
                    db.deleteLike(user.id(), articleId);
                    db.decLikeCount(articleId);
                  } else {
                    db.insertLike(user.id(), articleId);
                    db.incLikeCount(articleId);
                  }
                  // 计数必须在事务里读：Node 读的就是自己刚改完的那个数。事务外再读一次，
                  // 并发下会读到别人已提交的版本，两栈对同一次点击报出不同的 likeCount。
                  return new long[] { exists ? 0 : 1, NodeShapes.num(db.likeCountOf(articleId)) };
                })),
        "点赞事务未返回结果");
    return new Liked(counted[0] == 1, counted[1], NodeShapes.num(art.getAuthorId()), art.getTitle());
  }

  /* ==================== 收藏（toggle） ==================== */

  /**
   * INSERT IGNORE 的 affectedRows=1 即"这次真的收藏上了"；撞唯一键返回 0 则转为取消。
   *
   * <p>重放只针对死锁：同 (user, article) 高并发下这条 INSERT 会先取共享锁判唯一键，
   * 紧接的 DELETE 又要升级为排他锁，N 个请求各持一把 S 锁又都想要 X 锁就成环。
   * InnoDB 给这个环的解法就是回滚一方，官方建议亦为重放，故此处按 Node 同样的三次退避。
   */
  public boolean toggleBookmark(long userId, String slug) {
    Long articleId = db.publishedId(slug);
    if (articleId == null) {
      return false;
    }
    /*
     * INSERT IGNORE 的 affectedRows=1 即"这次真的收藏上了"；撞唯一键返回 0 则转为取消。
     *
     * <p>重放只针对死锁：同 (user, article) 高并发下这条 INSERT 会先取共享锁判唯一键，
     * 紧接的 DELETE 又要升级为排他锁，N 个请求各持一把 S 锁又都想要 X 锁就成环。
     * InnoDB 给这个环的解法就是回滚一方，官方建议亦为重放，故与 Node 同样退避三次。
     */
    return retryOnLock(() -> {
      if (db.insertBookmarkIgnore(userId, articleId) == 1) {
        return true;
      }
      db.deleteBookmark(userId, articleId);
      return false;
    });
  }

  /* ==================== 评论点赞 ==================== */

  public record CommentLiked(boolean liked, long likes) {}

  /** 与 Node 一致：这条链路没有事务，两句各自执行。 */
  public CommentLiked toggleCommentLike(long userId, long commentId) {
    boolean has = db.commentLikeRow(commentId, userId) != null;
    if (has) {
      db.deleteCommentLike(commentId, userId);
    } else {
      db.insertCommentLike(commentId, userId);
    }
    CommunityRows.Counter counted = db.commentLikeCount(commentId);
    return new CommentLiked(!has, NodeShapes.num(counted == null ? null : counted.getN()));
  }

  /* ==================== 关注 ==================== */

  public record Followed(boolean following, FollowCounts stats, String targetNickname) {}

  /** 关自己返回 null → 调用方按 400 "不能关注自己" 处理。 */
  public Followed toggleFollow(long followerId, long followeeId) {
    if (followerId == followeeId) {
      return null;
    }
    boolean wasFollowing = social.existsFollow(followerId, followeeId) != null;
    if (wasFollowing) {
      db.deleteFollow(followerId, followeeId);
    } else {
      db.insertFollowIgnore(followerId, followeeId);
    }
    return new Followed(!wasFollowing, social.followCounts(followeeId), nickname(followeeId));
  }

  /** 被关注者昵称：查不到只是不发通知，不影响关注本身已经落库。 */
  public String nickname(long userId) {
    try {
      CommunityRows.Nickname row = db.userNickname(userId);
      return row == null ? null : row.getNickname();
    } catch (RuntimeException unreadable) {
      return null;
    }
  }

  /**
   * 锁冲突重放。同一目标行上的并发 toggle 会成环死锁（InnoDB 的回法是回滚一方），
   * 重放整条语句/事务是安全的：回滚已经把这一方做的变更全部撤销，状态没动过。
   *
   * <p>与 Node 侧 {@code isRetryableLockError} 同一判据、同一三次退避——两侧都撞得到，
   * 只修一侧就等于把另一侧变成唯一的 500 来源。
   */
  private <T> T retryOnLock(Supplier<T> work) {
    for (int attempt = 1; ; attempt++) {
      try {
        return work.get();
      } catch (PessimisticLockingFailureException conflict) {
        if (attempt >= LOCK_ATTEMPTS) {
          throw conflict;
        }
        backoff(attempt);
      }
    }
  }

  private static void backoff(int attempt) {
    long wait = 5L + ThreadLocalRandom.current().nextInt(25) * attempt;
    try {
      Thread.sleep(wait);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}
