package com.inkstack.article;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.entity.FeedArticle;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

/**
 * 列表项视图：字段名与取值语义必须和 Node 端 listArticles 返回的对象完全一致，
 * 因为前端与对拍脚本都直接吃这个形状。
 */
public record ArticleView(
    String slug,
    String title,
    String author,
    String authorAvatar,
    Long authorId,
    String summary,
    String coverLabel,
    List<String> tags,
    long readCount,
    long commentCount,
    long agentQaCount,
    String publishedAt,
    String md,
    long likeCount,
    String boostUntil,
    long tipTotal,
    long unlockPrice,
    long discountPrice,
    String discountUntil) {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final DateTimeFormatter NODE_ISO =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");

  public static ArticleView from(FeedArticle row) {
    return new ArticleView(
        row.getSlug(), row.getTitle(), row.getAuthor(), nullToEmpty(row.getAuthorAvatar()),
        row.getAuthorId(), nullToEmpty(row.getSummary()), nullToEmpty(row.getCoverLabel()),
        parseTags(row.getTags()), num(row.getReadCount()), num(row.getCommentCount()),
        num(row.getAgentQaCount()), nullToEmpty(row.getPublishedAt()), "", num(row.getLikeCount()),
        iso(row.getBoostUntil()), num(row.getTipTotal()), num(row.getUnlockPrice()),
        num(row.getDiscountPrice()), iso(row.getDiscountUntil()));
  }

  /** 与 Node 同兜底：非数组或解析失败一律空数组，不让脏数据把整个信息流打挂。 */
  private static List<String> parseTags(String json) {
    if (json == null || json.isBlank()) {
      return List.of();
    }
    try {
      Object parsed = MAPPER.readValue(json, Object.class);
      if (parsed instanceof List<?> list) {
        return list.stream().map(String::valueOf).toList();
      }
      return List.of();
    } catch (Exception malformed) {
      return List.of();
    }
  }

  /** DATETIME → 与 JS Date#toISOString 同格式的 UTC 串（毫秒恒显三位）。 */
  private static String iso(LocalDateTime value) {
    if (value == null) {
      return null;
    }
    return NODE_ISO.format(value.atZone(ZoneId.systemDefault()).toInstant().atZone(ZoneOffset.UTC));
  }

  private static String nullToEmpty(String value) {
    return value == null ? "" : value;
  }

  private static long num(Long value) {
    return value == null ? 0L : value;
  }
}
