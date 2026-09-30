package com.inkstack.ai;

import com.inkstack.mapper.AgentQaMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 一条问答流水与它的文章计数——这两笔写必须在同一个事务里。
 *
 * <p>为什么要单独立一个 bean：{@code @Transactional} 走的是代理，同类内部自调用（
 * {@code this.record(...)}）不经代理就等于没加事务。AgentAskService 里三条通道各自要记一笔，
 * 把它们都指向这里，事务边界才有唯一的一处定义。
 *
 * <p>{@code agent_qa_count} 是一列**计数器**，不是一个 COUNT(*)：它进了文章重力排序的式子
 * （{@code agent_qa_count * 10}），逐行统计会让每次列表查询都付一次相关子查询。计数器就会漂，
 * 而漂的方式是"INSERT 成功、UPDATE 失败"这种一半成功——所以两笔写要么一起成，要么一起回滚。
 * 调用方按既有姿势把整笔失败吞掉（流水写失败不阻塞回答），吞掉的是整笔，不是半笔。
 *
 * <p>历史流水的 {@code article_id} 全是 NULL（那一列以前根本不在 INSERT 里），
 * 所以计数**没有可回填的过去**：种子写进 {@code agent_qa_count} 的那些数字是展示用的虚构值，
 * 与流水无关，也不该被本轮改动去"纠正"——真要统一，得先决定那些种子数字代表什么。
 */
@Service
public class AgentQaRecorder {

  private final AgentQaMapper qa;

  public AgentQaRecorder(AgentQaMapper qa) {
    this.qa = qa;
  }

  /**
   * @param articleSlug 读者此刻站在哪篇文章前问的（不在文章页就是空串）；认领不到就记 NULL
   * @return 认领到的文章 id，{@code null} 表示这笔流水不归属任何文章
   */
  @Transactional
  public Long record(Long askerId, String articleSlug, String question, String answer, String citations) {
    Long articleId = articleSlug == null || articleSlug.isEmpty()
        ? null : qa.findPublishedIdBySlug(articleSlug);
    qa.insert(askerId, articleId, question, answer, citations);
    if (articleId != null) {
      qa.bumpQaCount(articleId);
    }
    return articleId;
  }
}
