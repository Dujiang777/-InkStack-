package com.inkstack.ai;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.RagRows.ArticleMd;
import com.inkstack.mapper.RagMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * RAG 检索层，对应 {@code lib/rag.ts}：全文检索出候选文章，再在 Java 侧切段落挑相关段。
 *
 * <p>挑段这段逻辑看起来像"排序细节"，其实它决定分身引用了哪几句、进而决定回答里出现什么。
 * 两栈只要有一处口径不同（空白判据、码点遍历、split 是否留空串），回答就会一边引用《A》一边引用《B》，
 * 而对拍两侧都"看起来正常"。所以这里逐符号照抄，并在注释里标出每一处不显然的地方。
 */
@Service
public class RagService {

  /** 检索到的段落：标题原样带回，正文裁到 300 字。 */
  public record Snippet(String title, String text) {}

  private static final Pattern BLANK_LINE = Pattern.compile("\n{2,}");
  /** Markdown 噪声：标题井号、引用尖括号、列表星号、行内码反引号、方括号、连字符。 */
  private static final Pattern MD_NOISE = Pattern.compile("[#>*`\\[\\]-]");
  /** 问题里的标点与空白一律不参与"这段是否相关"的判断。{@code \s} 必须按 JS 的集合展开。 */
  private static final Pattern QUESTION_NOISE =
      Pattern.compile("[？?！!，。、" + NodeShapes.JS_SPACE_CHARS + "]");

  private final RagMapper rag;

  public RagService(RagMapper rag) {
    this.rag = rag;
  }

  /**
   * @param viewerId 提问者，游客传 0；未解锁的付费文不进语料（防分身复述付费正文）
   */
  public List<Snippet> retrieve(String question, long viewerId) {
    long me = viewerId > 0 ? viewerId : 0L;
    List<ArticleMd> rows;
    try {
      rows = rag.retrieve(question, me);
    } catch (RuntimeException unreachable) {
      // Node 的整段 try/catch：库或全文索引不可用时返回空语料，分身照样回答（并据此声明答不准）
      return List.of();
    }
    String keywords = QUESTION_NOISE.matcher(question == null ? "" : question).replaceAll("");
    List<Snippet> out = new ArrayList<>();
    for (ArticleMd row : rows) {
      String md = row.getMd() == null ? "" : row.getMd();
      List<String> paragraphs = new ArrayList<>();
      // limit=-1：JS 的 split 保留结尾空串，Java 默认丢掉——这里必须是 JS 的口径
      for (String piece : BLANK_LINE.split(md, -1)) {
        String cleaned = NodeShapes.jsTrim(MD_NOISE.matcher(piece).replaceAll(""));
        if (cleaned.length() > 30) {
          paragraphs.add(cleaned);
        }
      }
      List<String> hits = new ArrayList<>();
      for (String paragraph : paragraphs) {
        if (codePoints(keywords).anyMatch(paragraph::contains)) {
          hits.add(paragraph);
          if (hits.size() == 2) {
            break;
          }
        }
      }
      List<String> picked = hits.isEmpty() ? paragraphs.stream().limit(1).toList() : hits;
      for (String paragraph : picked) {
        out.add(new Snippet(String.valueOf(row.getTitle()), NodeShapes.slice(paragraph, 300)));
      }
    }
    return out.stream().limit(5).toList();
  }

  /** JS 的 {@code [...str]} 是按**码点**展开，Java 的 char 流会把 emoji 劈成两半。 */
  private static java.util.stream.Stream<String> codePoints(String value) {
    return value.codePoints().mapToObj(Character::toString);
  }
}
