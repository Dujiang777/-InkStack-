package com.inkstack.study;

import com.inkstack.mapper.StudyMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 一次阅读的两笔写：足迹行与 {@code articles.read_count}，必须同生同死。
 *
 * <p>{@code read_count} 在换栈前后**都从来没有人写**——只有 {@code db/schema.sql} 末尾那三行种子
 * 给过它 12840/4200/3800。而它是热榜排序的一项、是「总阅读破 100 / 破 1000」两枚徽章的宾语、
 * 也是书房漏斗里付费墙转化率的分母。一个永远不动的数字当分母，表现是"转化率突然超过 100%"
 * 而任何单点判据都看不出来。
 *
 * <p>口径（2026-09-30 定）：<b>登录读者每打开一次算一次</b>，游客不计——{@code POST /api/history}
 * 本来就只对游客回 {@code skipped}。所以这个数与 {@code SUM(read_history.read_times)} 是同一件事的
 * 两个名字：读一次，足迹那边 +1（首读新建行 1，重读 {@code read_times+1}），文章这边也 +1。
 * 闸门 21 拿这个等式做复算判据。
 *
 * <p>为什么要单独立一个 bean：{@code @Transactional} 走代理，同类内部自调用等于没加事务
 * （与 {@link com.inkstack.ai.AgentQaRecorder} 同一条理由）。
 */
@Service
public class ArticleReadRecorder {

  private final StudyMapper db;

  public ArticleReadRecorder(StudyMapper db) {
    this.db = db;
  }

  /**
   * @return {@code false} 表示这一次根本没有文章可记（slug 不存在或不是已发布），
   *         此时两笔写都没发生，返回值也只是给调用方决定要不要落一条审计用
   */
  @Transactional
  public boolean record(long uid, String slug) {
    // 先 +1 再记足迹：影响 0 行就说明这不是一篇公开文章，那一次足迹也不该凭空多出来。
    // 反过来的话，"文章在两步之间被撤回"会留下一条没有计数的足迹行。
    if (db.bumpReadCount(slug) == 0) {
      return false;
    }
    db.recordRead(uid, slug);
    return true;
  }
}
