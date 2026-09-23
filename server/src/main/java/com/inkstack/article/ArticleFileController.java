package com.inkstack.article;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.AdminRows;
import com.inkstack.entity.ArticleDetail;
import com.inkstack.mapper.ArticleMapper;
import com.inkstack.admin.AdminService;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * 创作台取原文（{@code /raw}）与导出 Markdown（{@code /export}）。
 *
 * <p>两条都是"把全文交出去"的口子，所以各自的防线不同：raw 靠<b>作者本人/运营</b>这一条硬判，
 * export 靠<b>付费墙</b>（未解锁的付费文一律 402，游客与登录未购都不给）。
 * 少判一句就是一个可以无限拉全文的洞。
 */
@RestController
public class ArticleFileController {

  /**
   * JS 的 {@code \s} 与 Java 的不是一套字符：JS 还认全角空格 U+3000、不换行空格 U+00A0、
   * 行分隔符 U+2028/2029 与 BOM。导出字数若用 Java 的 {@code \s}，一篇中文稿的
   * {@code words} 与 {@code reading_minutes} 就会与 Node 差几个字——那是要贴进 frontmatter 的数字。
   */
  private static final String JS_WS = "\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";
  private static final Pattern WS_RUN = Pattern.compile("[" + JS_WS + "]+");
  private static final Pattern TRAILING_WS = Pattern.compile("[" + JS_WS + "]+$");
  private static final Pattern LEADING_WS = Pattern.compile("[" + JS_WS + "]+");
  private static final Pattern OWN_H1 = Pattern.compile("^#[" + JS_WS + "]+[^\\r\\n]+\\r?\\n");

  /** encodeURIComponent 不逃的字符集（MDN 表上的 Unreserved Markers）。 */
  private static final String URI_UNRESERVED = "-_.!~*'()";

  private static final DateTimeFormatter UTC_DAY = DateTimeFormatter.ofPattern("yyyy-MM-dd");

  private final AdminService admin;
  private final ArticleMapper articles;
  private final String siteUrl;

  public ArticleFileController(
      AdminService admin, ArticleMapper articles,
      @Value("${inkstack.site-url:}") String siteUrl) {
    this.admin = admin;
    this.articles = articles;
    this.siteUrl = siteUrl == null ? "" : siteUrl;
  }

  /** 取原文：仅作者本人与运营可读，其余 403。 */
  @GetMapping("/api/articles/{slug}/raw")
  public ResponseEntity<Map<String, Object>> raw(
      @Current SessionUser me, @PathVariable String slug) {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "请先登录"));
    }
    AdminRows.Raw art;
    try {
      art = admin.raw(slug);
    } catch (RuntimeException failed) {
      return ResponseEntity.status(500).body(Map.of("error", "读取失败"));
    }
    if (art == null) {
      return ResponseEntity.status(404).body(Map.of("error", "文章不存在"));
    }
    if (NodeShapes.num(art.getAuthorId()) != me.id() && !me.isStaff()) {
      return ResponseEntity.status(403).body(Map.of("error", "仅作者本人可读取原文"));
    }
    Map<String, Object> article = new java.util.LinkedHashMap<>();
    article.put("slug", NodeShapes.text(art.getSlug()));
    article.put("title", NodeShapes.text(art.getTitle()));
    article.put("md", art.getMd() == null ? "" : String.valueOf(art.getMd()));
    article.put("summary", isEmpty(art.getSummary()) ? "" : art.getSummary());
    article.put("tags", NodeShapes.tags(art.getTags()));
    article.put("coverLabel", isEmpty(art.getCoverLabel()) ? "" : art.getCoverLabel());
    article.put("reviewStatus", art.getReviewStatus() == null ? "approved" : art.getReviewStatus());
    article.put("reviewNote", isEmpty(art.getReviewNote()) ? null : art.getReviewNote());
    article.put("status", art.getStatus() == null ? "published" : art.getStatus());
    article.put("unlockPrice", NodeShapes.num(art.getUnlockPrice()));
    article.put("discountPrice", NodeShapes.num(art.getDiscountPrice()));
    article.put("discountUntil", NodeShapes.iso(art.getDiscountUntil()));
    return ResponseEntity.ok(Map.of("article", article));
  }

  /** 导出 Markdown 附件。可见性判定复用读侧那一条，所以付费墙与详情页必然同口径。 */
  @GetMapping("/api/articles/{slug}/export")
  public ResponseEntity<String> export(
      @Current SessionUser me, @PathVariable String slug, HttpServletRequest request) {
    boolean privileged = me != null && me.isStaff();
    Long viewerId = me == null ? null : me.id();
    ArticleDetail art = articles.findDetail(slug, viewerId, privileged, true);
    if (art == null) {
      return text("Not Found", 404);
    }
    boolean own = me != null && me.id() == NodeShapes.num(art.getAuthorId());
    if (NodeShapes.num(art.getUnlockPrice()) > 0 && !NodeShapes.flag(art.getViewerUnlocked())
        && !own && !privileged) {
      return text("Payment Required", 402);
    }
    String md = NodeShapes.text(art.getMd());
    int words = stripWhitespace(md).length();
    long minutes = Math.max(1L, Math.round(words / 450d));
    String origin = originOf(request);
    String url = origin + "/article/" + slug;

    StringBuilder fm = new StringBuilder();
    fm.append("---\n");
    fm.append("title: ").append(yq(NodeShapes.text(art.getTitle()))).append('\n');
    fm.append("author: ").append(yq(NodeShapes.text(art.getAuthor()))).append('\n');
    fm.append("date: ").append(yq(NodeShapes.text(art.getPublishedAt()))).append('\n');
    List<String> tags = NodeShapes.tags(art.getTags());
    if (!tags.isEmpty()) {
      fm.append("tags:\n");
      for (String tag : tags) {
        fm.append("  - ").append(yq(tag)).append('\n');
      }
    } else {
      fm.append("tags: []\n");
    }
    fm.append("source: ").append(yq("墨栈 InkStack")).append('\n');
    fm.append("url: ").append(yq(url)).append('\n');
    fm.append("words: ").append(words).append('\n');
    fm.append("reading_minutes: ").append(minutes).append('\n');
    fm.append("---\n\n");

    // 与 Node 同一条：先 JS trim 再削尾部空白串。用 Java 的 trim 会留下全角空格/BOM 开头，
    // 导出文件与 Node 逐字节对不上（同样的一句话在 3000 字里只差一个字符，最难查）。
    String content = TRAILING_WS.matcher(NodeShapes.jsTrim(md)).replaceAll("");
    // Node：content.match(/^#\s+.+\r?\n/) —— 无 m 标志，^ 只锚串首；. 不跨行。
    Matcher h1 = OWN_H1.matcher(content);
    String bodyMd = content;
    if (h1.lookingAt()) {
      bodyMd = LEADING_WS.matcher(content.substring(h1.end())).replaceFirst("");
    }
    String byline = NodeShapes.text(art.getAuthor()) + " · " + NodeShapes.text(art.getPublishedAt())
        + " · 约 " + minutes + " 分钟读完 · [原文链接](" + url + ")";
    String footer = "\n\n---\n\n*本文导自 [墨栈 InkStack](" + origin + ") · 导出于 "
        + java.time.LocalDate.now(java.time.ZoneOffset.UTC).format(UTC_DAY)
        + " · 原文：[" + NodeShapes.text(art.getTitle()) + "](" + url + ")*\n";
    String body = fm + "# " + NodeShapes.text(art.getTitle()) + "\n\n> " + byline + "\n\n" + bodyMd + footer;

    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_TYPE, "text/markdown; charset=utf-8")
        .header(HttpHeaders.CONTENT_DISPOSITION,
            "attachment; filename=\"" + encodeURIComponent(slug) + ".md\"")
        .header(HttpHeaders.CACHE_CONTROL, "no-store")
        .body(body);
  }

  private static String stripWhitespace(String value) {
    return WS_RUN.matcher(value).replaceAll("");
  }

  /** JS 的 JSON.stringify(字符串)：值是合法 YAML 标量，标题里的冒号/引号就不会破坏 frontmatter。 */
  private static String yq(String value) {
    return com.inkstack.web.Bodies.jsonString(value);
  }

  private static boolean isEmpty(String value) {
    return value == null || value.isEmpty();
  }

  private static ResponseEntity<String> text(String body, int status) {
    return ResponseEntity.status(status).contentType(MediaType.TEXT_PLAIN).body(body);
  }

  /**
   * Node 的 {@code NEXT_PUBLIC_SITE_URL || new URL(req.url).origin}。
   *
   * <p>三级取值，顺序不能换：
   * <ol>
   *   <li>配了站点地址就用它——这是本仓库的铁律（与 OAuth redirect_uri 同源）；</li>
   *   <li>否则用 middleware 覆写的 {@code x-forwarded-host}：Next 的 rewrite 会把 Host 换成后端地址，
   *       不读这个头就会把 {@code http://localhost:3101} 这种内网地址写进读者下载的 Markdown；</li>
   *   <li>最后才是请求自己的 Host（直连 Java 的本地调试场景）。</li>
   * </ol>
   * 站点地址<b>不裁尾斜杠</b>：Node 也是直接拼串，裁了就会与它给出的形态不一致（导出要逐字节对得上）。
   */
  private String originOf(HttpServletRequest request) {
    if (!siteUrl.isEmpty()) {
      return siteUrl;
    }
    String scheme = "https".equals(NodeShapes.text(request.getHeader("x-forwarded-proto")))
        ? "https"
        : (request.isSecure() ? "https" : "http");
    String host = NodeShapes.text(request.getHeader("x-forwarded-host"));
    if (host.isEmpty()) {
      host = NodeShapes.text(request.getHeader("host"));
      int port = request.getServerPort();
      boolean standard = ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
      int colon = host.lastIndexOf(':');
      boolean hostHasPort = colon > 0 && host.substring(colon + 1).chars().allMatch(Character::isDigit)
          && String.valueOf(port).equals(host.substring(colon + 1));
      return scheme + "://" + host + (standard || hostHasPort ? "" : ":" + port);
    }
    return scheme + "://" + host;
  }

  static String encodeURIComponent(String raw) {
    StringBuilder out = new StringBuilder();
    for (byte b : raw.getBytes(StandardCharsets.UTF_8)) {
      char c = (char) (b & 0xFF);
      boolean safe = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
          || URI_UNRESERVED.indexOf(c) >= 0;
      if (safe) {
        out.append(c);
      } else {
        out.append('%').append(String.format("%02X", c));
      }
    }
    return out.toString();
  }
}
