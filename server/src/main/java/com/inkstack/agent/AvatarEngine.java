package com.inkstack.agent;

import com.inkstack.ai.RagService;
import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.model.tool.DefaultToolCallingManager;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.retry.support.RetryTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Java 侧的智能体引擎：Spring AI 的 ChatClient + 一个检索工具，替掉原来的
 * Python FastAPI + AgentScope {@code ReActAgent}（{@code agent-service/}）。
 *
 * <p>模型走 **OpenAI 兼容协议**，默认指向 DeepSeek 的 {@code /v1}——沿用部署里已有的那把
 * {@code DEEPSEEK_API_KEY}，不新增厂商也不新增凭据；换成百炼只改配置不改代码。
 *
 * <p>与 Python 版保持同一个形状：**先拿完整的最终回答，再切帧下发**。Python 也是
 * {@code await agent(...)} 得到整段文本后按 ~40 块 yield，所以这里用非流式 call
 * 并不损失什么，反而避开了"边解工具调用边吐字"这套两栈都没有的复杂度。
 *
 * <p>整个引擎是**可选**的：{@code inkstack.agent.engine=off}（默认）或没配 Key 时
 * {@link #available()} 为 false，调用方照旧走透传 / live / 演示三条通道。
 * 双轨期的对拍因此不受影响——开了引擎就必须把 {@code /api/ai}、{@code /api/agent}
 * 整前缀切给 Java，Node 那侧没有第四个通道。
 */
@Service
public class AvatarEngine {

  /** 最终回答里的引用行：「依据：《文章标题》……」，取到句号或行尾为止（与 Python 的正则同式）。 */
  private static final Pattern CITATION = Pattern.compile("依据[:：]\\s*(《[^》]+》[^。.\\n]*)");

  public record AvatarReply(String text, String citation) {}

  private final ChatClient client;
  private final RagService rag;
  private final boolean enabled;
  private final long timeoutMs;

  public AvatarEngine(RagService rag,
      @Value("${inkstack.agent.engine:off}") String engine,
      @Value("${inkstack.agent.model.base-url:https://api.deepseek.com/v1}") String baseUrl,
      @Value("${inkstack.agent.model.api-key:}") String apiKey,
      @Value("${inkstack.agent.model.name:deepseek-chat}") String modelName,
      @Value("${inkstack.agent.stream-timeout-ms:60000}") long streamTimeoutMs) {
    this.rag = rag;
    // 与透传/live 两条通道同一个旋钮、同一个"设成 0 或负数就退回 60 秒"的口径：
    // 这里以前硬编码着一个 60，于是那个旋钮管得动另外两条通道，管不动这一条。
    this.timeoutMs = streamTimeoutMs > 0 ? streamTimeoutMs : 60_000L;
    this.enabled = "spring-ai".equalsIgnoreCase(engine.trim()) && !apiKey.isEmpty();
    if (!this.enabled) {
      this.client = null;
      return;
    }
    // 超时显式设：默认的连接工厂可以一直等下去。用 JDK 那个工厂而不是 Simple，因为
    // SimpleClientHttpRequestFactory 的 readTimeout 是**每次读**的——上游每 59 秒吐一个字节
    // 就永远不触发（本机实测一次往返 150 秒还在正常完成）。Jdk 那个是到点自己去关响应体，
    // 是**这一次往返**的绝对截止。而整串往返由 EngineDeadline 兜，理由写在那个类里。
    HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(8))
        .build();
    JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(http);
    factory.setReadTimeout(Duration.ofMillis(timeoutMs));
    OpenAiApi api = OpenAiApi.builder()
        .baseUrl(baseUrl)
        .apiKey(apiKey)
        .restClientBuilder(RestClient.builder()
            .requestFactory(factory)
            .requestInterceptor(EngineDeadline.interceptor()))
        .build();
    OpenAiChatModel model = OpenAiChatModel.builder()
        .openAiApi(api)
        .defaultOptions(OpenAiChatOptions.builder().model(modelName).temperature(0.7).build())
        .toolCallingManager(DefaultToolCallingManager.builder().build())
        // 显式收成"不重试"：Spring AI 自带的是指数退避重试，实测一个 502 会被拖成四分钟
        // （2s / 10s / 50s / 180s 各撞一次超时），既占死一个 Tomcat 线程，也早就越过读者等
        // 分身回答的 60 秒预算。Node 那条 live 通道本来就是一次 fetch 定生死——同口径。
        .retryTemplate(RetryTemplate.builder().maxAttempts(1).build())
        .build();
    this.client = ChatClient.create(model);
  }

  public boolean available() {
    return enabled;
  }

  /** 分身回答：允许模型自主调用检索工具（ReAct 一轮或多轮），返回最终文本与抽出的引用。 */
  public AvatarReply ask(String question, String author, String about, long viewerId) {
    if (!enabled) {
      return null;
    }
    // 一次交换一个截止，覆盖这一整串往返。被掐断时抛出来的是 IOException: closed，
    // 落进下面既有的 catch——与"引擎没产出"是同一条出口：调用方转演示档、零扣墨，
    // 这里不给它单独编一套说法（读者还没有收到任何一帧，谈不上"截断要说话"）。
    try (EngineDeadline deadline = EngineDeadline.arm(timeoutMs)) {
      String text = client.prompt()
          .system(avatarSystemPrompt(author, about))
          .user(question)
          .tools(new ArticleSearchTool(rag, viewerId))
          .call()
          .content();
      if (text == null || text.isBlank()) {
        return null;
      }
      Matcher citation = CITATION.matcher(text);
      return new AvatarReply(text, citation.find() ? citation.group(1).trim() : null);
    } catch (Exception failed) {
      return null;
    }
  }

  /** 写作助手：单次生成，无工具。失败返回 null，由调用方落模板兜底。 */
  public String write(String mode, String prompt, String author) {
    if (!enabled) {
      return null;
    }
    // 这条现在只有一次往返，挂截止是为了让这个旋钮对引擎的两次调用都算数——
    // 只给问答那条挂，等于"哪天写作也带上工具，就又没了界"。
    try (EngineDeadline deadline = EngineDeadline.arm(timeoutMs)) {
      String text = client.prompt()
          .system("你是博主「" + author + "」的写作助手，延续其个人文风，输出干净、可直接使用。")
          .user(prompt)
          .call()
          .content();
      return text == null || text.isBlank() ? null : text;
    } catch (Exception failed) {
      return null;
    }
  }

  /** 分身的 system prompt：四条规则与 Python 版逐条对应，另加"正在读哪篇"的上下文。 */
  private static String avatarSystemPrompt(String author, String about) {
    return "你是博主「" + author + "」的 AI 数字分身，以他的口吻回答读者提问。语气：严谨、克制、重依据。\n"
        + (about.isEmpty() ? "" : "读者当前正在阅读《" + about + "》，回答可优先围绕这篇文章展开。\n")
        + "规则：\n"
        + "1. 涉及博主文章内容的问题，先调用 searchBlogArticles 检索，回答必须基于片段；\n"
        + "2. 回答末尾用一行「依据：《文章标题》」标注来源；\n"
        + "3. 检索不到依据时如实告知答不准，建议转达博主，绝不编造；\n"
        + "4. 回答控制在 200 字内。\n"
        + "最后，把完整回答作为最终消息返回。";
  }
}
