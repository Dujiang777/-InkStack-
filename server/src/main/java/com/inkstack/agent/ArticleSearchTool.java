package com.inkstack.agent;

import com.inkstack.ai.RagService;
import java.util.List;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;

/**
 * 检索工具：把博主文章里相关的段落交给模型引用。对应 Python 版的
 * {@code search_blog_articles}，但**语料口径按 {@code lib/rag.ts} 走**——
 * Python 那条 SQL 少了 {@code review_status='approved'} 与付费墙判定，
 * 等于让分身把没过审的稿子和没解锁的付费正文念给读者听。这是这次替换顺手补掉的洞。
 *
 * <p>每个请求 new 一个：工具必须知道"提问者是谁"才能算付费墙，而 Spring 的 @Tool 对象
 * 是随请求传进 ChatClient 的，不该做成单例。
 */
public class ArticleSearchTool {

  private final RagService rag;
  private final long viewerId;

  public ArticleSearchTool(RagService rag, long viewerId) {
    this.rag = rag;
    this.viewerId = viewerId;
  }

  @Tool(description = "在博主已发布的文章里检索与问题相关的段落。"
      + "当且仅当需要依据博主的文章内容回答时调用；返回带《来源标题》的片段列表，回答必须依据片段并注明来源。")
  public String searchBlogArticles(
      @ToolParam(description = "读者提问的原句") String question) {
    List<RagService.Snippet> snippets = rag.retrieve(question == null ? "" : question, viewerId);
    if (snippets.isEmpty()) {
      return "知识库中没有检索到相关文章片段。请不要编造，明确告知读者答不准。";
    }
    // 输出形状照抄 Python 版工具：《标题》：段落，段与段之间空行
    StringBuilder out = new StringBuilder();
    for (RagService.Snippet snippet : snippets) {
      if (!out.isEmpty()) {
        out.append("\n\n");
      }
      out.append("《").append(snippet.title()).append("》：").append(snippet.text());
    }
    return out.toString();
  }
}
