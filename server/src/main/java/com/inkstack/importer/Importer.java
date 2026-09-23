package com.inkstack.importer;

import com.inkstack.common.NodeDates;
import com.inkstack.common.NodeShapes;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 迁移工具的解析核心，逐条对齐 {@code lib/importer.ts}：RSS2.0 / Atom 解析、外部 HTML 消毒、
 * Markdown 摘要与文件名兜底标题。
 *
 * <p>消毒用的是那七条正则而不是白名单式 DOMPurify——这是原实现有意的取舍（RSS 正文是外部 HTML，
 * 而 Markdown 文件是博主自己的内容、代码块里的 {@code <script>} 由渲染层转义）。
 * 移植时**一条都不能"顺手改严"**：消毒结果直接进库，改一条就等于把已导入的旧文章和新导入的
 * 写成两种样子。正则里的 {@code \s} 一律换成 {@link NodeShapes#JS_SPACE}——Java 的 {@code \s}
 * 少认全角空格那一整排，标签之间的分隔符判断就会两栈不一致。
 */
public final class Importer {

  private Importer() {}

  /** 一次最多解析/导入的条数。 */
  public static final int MAX_ITEMS = 20;
  /** 订阅源响应体上限（字符数，与 Node 的 {@code xml.length} 同口径）。 */
  public static final int MAX_XML = 2_000_000;
  /** 单个 Markdown 文件上限（字节）。 */
  public static final int MAX_MD_FILE = 300_000;

  public record Item(String title, String md, String summary, Instant publishedAt) {}

  private static final String JS = NodeShapes.JS_SPACE;
  private static final String NOT_JS = "[^" + NodeShapes.JS_SPACE_CHARS + ">]";

  /** 消毒外部 HTML：去除可执行 / 可嵌入内容，顺序与产物都与 Node 一致。 */
  public static String sanitizeHtml(String html) {
    String out = html;
    out = out.replaceAll("(?i)<script[\\s\\S]*?</script>", "");
    out = out.replaceAll("(?i)<iframe[\\s\\S]*?(</iframe>|/>)", "");
    out = out.replaceAll("(?i)<object[\\s\\S]*?</object>", "");
    out = out.replaceAll("(?i)<embed[^>]*>", "");
    out = out.replaceAll("(?i)<style[\\s\\S]*?</style>", "");
    out = out.replaceAll("(?i)" + JS + "on\\w+" + JS + "*=" + JS + "*("
        + JS + "*\"[^\"]*\"|" + JS + "*'[^']*'|" + JS + "*" + NOT_JS + "+)", "");
    return out.replaceAll("(?i)(href|src)" + JS + "*=" + JS + "*(\"|')" + JS + "*javascript:[^\"']*\\2",
        "$1=\"#\"");
  }

  private static final Pattern CDATA = Pattern.compile("^<!\\[CDATA\\[([\\s\\S]*)\\]\\]>$");

  /** 取块内某个标签的文本，去 CDATA 包裹并解常见实体——标题里最常见的那五个。 */
  static String tagText(String block, String name) {
    Matcher m = Pattern.compile("<" + Pattern.quote(name) + "(?:" + JS + "[^>]*)?>([\\s\\S]*?)</"
        + Pattern.quote(name) + ">", Pattern.CASE_INSENSITIVE).matcher(block);
    if (!m.find()) {
      return "";
    }
    String v = NodeShapes.jsTrim(m.group(1));
    Matcher cdata = CDATA.matcher(v);
    if (cdata.matches()) {
      v = NodeShapes.jsTrim(cdata.group(1));
    }
    return v.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
        .replace("&#39;", "'").replace("&amp;", "&");
  }

  /** 去掉 Markdown 标记取纯文本，用于摘要。 */
  public static String stripMd(String md) {
    String out = md;
    out = out.replaceAll("!\\[[^\\]]*\\]\\([^)]*\\)", "");
    out = out.replaceAll("\\[([^\\]]*)\\]\\([^)]*\\)", "$1");
    out = out.replaceAll("(?m)^" + JS + "{0,3}#{1,6}" + JS + "+", "");
    out = out.replaceAll("[*_`~]{1,3}", "");
    out = out.replaceAll("(?m)^" + JS + "*[-+>]" + JS + "+", "");
    return NodeShapes.jsTrim(NodeShapes.jsSqueeze(out));
  }

  private static final String[] PARAGRAPH_SKIP = {
      "^#{1,6}" + JS, "^!\\[", "^" + JS + "*[-*|`]"};

  private static String firstParagraph(String md) {
    for (String line : md.split("\n", -1)) {
      String t = NodeShapes.jsTrim(line);
      if (t.isEmpty()) {
        continue;
      }
      boolean skip = false;
      for (String re : PARAGRAPH_SKIP) {
        if (Pattern.compile(re).matcher(t).find()) {
          skip = true;
          break;
        }
      }
      if (skip) {
        continue;
      }
      return stripMd(t);
    }
    return "";
  }

  private static final Pattern ITEM = Pattern.compile(
      "<item(?:" + JS + "[^>]*)?>([\\s\\S]*?)</item>", Pattern.CASE_INSENSITIVE);
  private static final Pattern ENTRY = Pattern.compile(
      "<entry(?:" + JS + "[^>]*)?>([\\s\\S]*?)</entry>", Pattern.CASE_INSENSITIVE);

  /** 解析 RSS2.0 / Atom 订阅源，最多取前 20 条。 */
  public static List<Item> parseFeed(String xml) {
    List<String> blocks = new ArrayList<>();
    Matcher items = ITEM.matcher(xml);
    while (items.find()) {
      blocks.add(items.group(1));
    }
    Matcher entries = ENTRY.matcher(xml);
    while (entries.find()) {
      blocks.add(entries.group(1));
    }
    List<Item> out = new ArrayList<>();
    for (String block : blocks.subList(0, Math.min(blocks.size(), MAX_ITEMS))) {
      String rawTitle = tagText(block, "title");
      if (rawTitle.isEmpty()) {
        continue;
      }
      String content = nonEmpty(tagText(block, "content:encoded"), tagText(block, "content"),
          tagText(block, "description"), tagText(block, "summary"));
      String dateStr = nonEmpty(tagText(block, "pubDate"), tagText(block, "published"),
          tagText(block, "updated"));
      out.add(new Item(
          NodeShapes.slice(stripMd(rawTitle), 200),
          sanitizeHtml(content),
          NodeShapes.slice(stripMd(content), 180),
          dateStr.isEmpty() ? null : NodeDates.parse(dateStr)));
    }
    return out;
  }

  private static String nonEmpty(String... values) {
    for (String v : values) {
      if (v != null && !v.isEmpty()) {
        return v;
      }
    }
    return "";
  }

  private static final Pattern MD_TITLE = Pattern.compile("(?m)^" + JS + "*#" + JS + "+(.+?)" + JS + "*$");
  private static final Pattern MD_EXT = Pattern.compile("\\.(md|markdown|txt)$", Pattern.CASE_INSENSITIVE);

  /** 解析单个 Markdown 文件：标题取首个一级标题，否则用文件名。 */
  public static Item parseMarkdownFile(String text, String filename) {
    Matcher titleMatch = MD_TITLE.matcher(text);
    String fallback = NodeShapes.jsTrim(
        MD_EXT.matcher(filename).replaceAll("").replaceAll("[-_]+", " "));
    String title = titleMatch.find()
        ? titleMatch.group(1)
        : (fallback.isEmpty() ? "未命名文章" : fallback);
    return new Item(
        NodeShapes.slice(title, 200),
        NodeShapes.jsTrim(text),
        NodeShapes.slice(firstParagraph(text), 180),
        null);
  }

  /** 文件名的扩展名白名单判断（不合法的进 __SKIP__ 分支）。 */
  public static boolean markdownish(String filename) {
    return MD_EXT.matcher(filename).find();
  }
}
