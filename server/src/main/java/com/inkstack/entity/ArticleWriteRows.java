package com.inkstack.entity;

import java.util.List;
import lombok.Data;

/** 创作台写链路的入参行与前置读。 */
public final class ArticleWriteRows {

  private ArticleWriteRows() {}

  /**
   * 一篇待写入的稿子。{@code tags} 保持数组，落库前由服务层序列化成 JSON 文本
   * （Node 传的就是 {@code JSON.stringify(tags)}，两侧必须是同一种字符串）。
   */
  @Data
  public static class Row {
    private Long authorId;
    private String title;
    private String md;
    private String summary;
    private String coverLabel;
    private List<String> tags;
    private Long unlockPrice;
    private Long discountPrice;
    private String discountUntil;
    private String reviewStatus;
  }

  /** 编辑/撤回的前置读：只需要主键、作者与状态三列。 */
  @Data
  public static class Head {
    private Long id;
    private Long authorId;
    private String status;
  }
}
