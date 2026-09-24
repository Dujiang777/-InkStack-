package com.inkstack.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.agent.AvatarEngine;
import com.inkstack.common.NodeShapes;
import com.inkstack.mapper.AgentQaMapper;
import com.inkstack.points.PointsService;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * {@code POST /api/agent/ask} —— 博主分身问答，NDJSON 流式。对应 {@code app/api/agent/ask/route.ts}。
 *
 * <p>三条通道、一份协议：每行一个 JSON，只允许三种帧 ——
 * {@code {"type":"delta","text":…}}、结尾恰好一条 {@code {"type":"cite","citation":…}}（可为 null）、
 * 或一条 {@code {"type":"error","message":…}}。没有 {@code [DONE]} 哨兵，靠连接关闭收尾。
 * 前端按行切着渲染，所以帧的形状与顺序就是接口契约本身：多一帧、少一帧、键序换了，
 * 表现都是"回答显示不全"这种查起来很慢的问题。
 *
 * <p>计费口径与 {@code /api/ai/write} 同一条：<b>上游确认可用之后才扣</b>。
 * 三条通道各自的"可用"判据不同——透传通道是上游返回 2xx，live 是 DeepSeek 给出 2xx 响应头，
 * demo 压根不扣。上游坏在任何一步都零扣墨，而扣了墨之后中途炸掉则按成功计费（货已发出一半）。
 */
@Service
public class AgentAskService {

  /** 问答单价：经济收紧后由 2 上调至 5，Node 同值。 */
  public static final long QA_COST = 5;

  /** 流式体的写法：控制器只负责"提交响应 + 逐帧 flush"，通道选择与扣墨都在这一侧。 */
  @FunctionalInterface
  public interface StreamBody {
    void write(OutputStream out) throws Exception;
  }

  /** 要么是一个普通 JSON 响应（400/401/402），要么是一条 NDJSON 流。 */
  public sealed interface Reply {

    record Status(int code, Map<String, Object> body) implements Reply {}

    record Stream(StreamBody body) implements Reply {}
  }

  /** 一条历史发言：{@code role} 已由控制器按 Node 的过滤口径归一成 user / assistant。 */
  public record Turn(String role, String content) {}

  private record Answer(String text, String citation) {}

  private static final Map<String, Answer> KB = new LinkedHashMap<>();

  static {
    KB.put("为什么 then 要进微任务？", new Answer(
        "因为 Promises/A+ 规范 §2.2.4 要求 onFulfilled/onRejected 必须在「平台代码」之外的执行上下文中调用"
            + "——也就是不能同步执行。微任务是浏览器给 Promise 的专用通道，比 setTimeout 更早、更稳定。"
            + "文章第 2 节完整推演过这个时序。",
        "《手写 Promise》第 2 节「then 的微任务语义」"));
    KB.put("循环 thenable 怎么检测？", new Answer(
        "在 then 的解析过程中维护一个 thenablesOf 集合，每次取出 thenable 时先检查它是否已在集合中"
            + "——若在，说明出现了自引用循环，直接 reject 一个 TypeError。测试用例第 31 个用例专门构造了这个场景。",
        "《手写 Promise》第 3 节 + 测试用例 #31"));
    KB.put("和原生性能差距？", new Answer(
        "千次链式调用基准下，手写版约为原生的 60%–70%，差距主要来自微任务队列的数组调度。"
            + "对博客场景完全可以接受。原始数据不在本篇文章内，引用的是《异步专栏·第 9 篇》。",
        "《异步专栏 · 第 9 篇》性能基准"));
  }

  private static final Answer FALLBACK = new Answer(
      "这个问题在我的知识库里没有足够依据，与其瞎猜，不如转达给博主本人——他通常 12 小时内会回复。"
          + "你也可以换个更具体的问法试试。",
      null);

  private final PointsService points;
  private final RagService rag;
  private final AgentQaMapper qa;
  private final AvatarEngine engine;
  private final String agentServiceUrl;
  private final String deepseekKey;
  private final String deepseekBase;
  private final ObjectMapper json = new ObjectMapper();
  private final HttpClient http = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(8))
      .build();

  public AgentAskService(PointsService points, RagService rag, AgentQaMapper qa, AvatarEngine engine,
      @Value("${inkstack.agent.service-url:}") String agentServiceUrl,
      @Value("${inkstack.agent.deepseek-key:}") String deepseekKey,
      @Value("${inkstack.agent.deepseek-base:https://api.deepseek.com}") String deepseekBase) {
    this.points = points;
    this.rag = rag;
    this.qa = qa;
    this.engine = engine;
    this.agentServiceUrl = agentServiceUrl;
    this.deepseekKey = deepseekKey;
    this.deepseekBase = deepseekBase;
  }

  /**
   * @param uid 登录用户；{@code null} 是游客——演示通道对游客开放，另两条通道会先要登录
   */
  public Reply ask(Long uid, String question, String author, String about, List<Turn> history) {
    if (question.isEmpty()) {
      return new Reply.Status(400, Map.of("error", "question 不能为空"));
    }

    String agentUrl = trimSlash(agentServiceUrl);
    if (agentUrl.isEmpty() && engine.available()) {
      // 第四通道：Java 侧 Spring AI 智能体。它与 live 通道同一种"钱停在哪儿"的规矩——
      // 先让模型把整段回答生成出来，确认非空，才扣这一次墨。
      Reply fromEngine = askNative(uid, question, author, about);
      if (fromEngine != null) {
        return fromEngine;
      }
      // 引擎没给出可用产出（没配 Key、上游炸了、返回空）→ 继续往下落演示通道
    }
    if (!agentUrl.isEmpty()) {
      if (uid == null) {
        return new Reply.Status(401, Map.of("error", "登录后才能与分身对话"));
      }
      long bal = points.peekBalance(uid);
      if (bal < QA_COST) {
        return new Reply.Status(402, Map.of("error", "墨水不足（余额 " + bal + "，本次需 " + QA_COST + "）"));
      }
      // 透传：扣墨放在"上游确实回了 2xx"之后。服务没起就静默落回内置模式，
      // 不能让演示回答被扣费墙拦住（Node 同式）。
      HttpResponse<InputStream> upstream = postJson(agentUrl + "/agent/ask", passthroughPayload(question, author, about));
      if (upstream != null) {
        boolean usable = upstream.statusCode() >= 200 && upstream.statusCode() <= 299;
        if (!usable) {
          closeQuietly(upstream.body());
        } else {
          PointsService.Spend spend = points.spend(uid, QA_COST, "分身问答");
          if (!spend.ok()) {
            // 并发花超：放弃这条上游流，一帧都不下发（没收钱，也就不存在退钱）
            closeQuietly(upstream.body());
            return new Reply.Status(402, Map.of("error", nullToEmpty(spend.error())));
          }
          insertQa(uid, question, "(AgentScope streamed)", "[]");
          long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
          return new Reply.Stream(out -> pump(upstream.body(), out, deadline));
        }
      }
    }

    boolean live = jsTruthy(deepseekKey);
    if (live) {
      if (uid == null) {
        return new Reply.Status(401, Map.of("error", "登录后才能与分身对话"));
      }
      long bal = points.peekBalance(uid);
      if (bal < QA_COST) {
        return new Reply.Status(402, Map.of("error", "墨水不足（余额 " + bal + "，本次需 " + QA_COST + "）"));
      }
      return new Reply.Stream(out -> streamLive(out, uid, question, author, about, history));
    }
    return new Reply.Stream(out -> streamDemo(out, question));
  }

  /* ==================== 通道 ⓪：Spring AI 智能体（顶掉 Python 服务的那一条） ==================== */

  /**
   * 引擎给得出可用产出时返回一条流式应答，否则返回 {@code null} 让调用方继续往下挑通道。
   *
   * <p>鉴权与预检的姿势与 live 通道一致：登录 + 只读探针在前，扣款在模型给出非空回答之后。
   */
  private Reply askNative(Long uid, String question, String author, String about) {
    if (uid == null) {
      return new Reply.Status(401, Map.of("error", "登录后才能与分身对话"));
    }
    long bal = points.peekBalance(uid);
    if (bal < QA_COST) {
      return new Reply.Status(402, Map.of("error", "墨水不足（余额 " + bal + "，本次需 " + QA_COST + "）"));
    }
    AvatarEngine.AvatarReply reply = engine.ask(question, author, about, uid);
    if (reply == null) {
      return null;
    }
    PointsService.Spend spend = points.spend(uid, QA_COST, "分身问答");
    if (!spend.ok()) {
      return new Reply.Status(402, Map.of("error", nullToEmpty(spend.error())));
    }
    try {
      insertQa(uid, question, reply.text(), reply.citation() == null
          ? "[]" : json.writeValueAsString(List.of(reply.citation())));
    } catch (Exception qaFailed) {
      // 流水失败不阻塞回答
    }
    return new Reply.Stream(out -> emitFrames(out, reply));
  }

  /**
   * 整段回答切帧下发：切块宽度沿用 Python 的 {@code max(1, len // 40)}，
   * 末尾一条 cite。读者看到的节奏与原来那台服务一致——换引擎不该换打字机速度。
   */
  private void emitFrames(OutputStream out, AvatarEngine.AvatarReply reply) {
    String text = reply.text();
    int step = Math.max(1, text.length() / 40);
    for (int i = 0; i < text.length(); i += step) {
      send(out, frame("type", "delta", "text", NodeShapes.slice(text, i, i + step)));
    }
    send(out, frame("type", "cite", "citation", reply.citation()));
  }

  /* ==================== 通道 ②：DeepSeek 流式 ==================== */

  private void streamLive(OutputStream out, long uid, String question, String author,
      String about, List<Turn> history) {
    boolean charged = false;
    try {
      List<RagService.Snippet> snippets = rag.retrieve(question, uid);
      HttpResponse<InputStream> res = postJson(deepseekUrl(), deepseekPayload(author, snippets, about, history, question),
          "Bearer " + deepseekKey);
      if (res == null) {
        // 连不上：Node 那边 fetch 抛错会进下面的 catch，给出带异常名的 error 帧；
        // 这里同样按"服务异常"下发一帧，而不是让流凭空断掉。
        send(out, frame("type", "error", "message", "服务异常，本次未扣墨水"));
        return;
      }
      if (res.statusCode() < 200 || res.statusCode() > 299) {
        closeQuietly(res.body());
        send(out, frame("type", "error",
            "message", "AI 服务暂不可用（DeepSeek API " + res.statusCode() + "），本次未扣墨水"));
        return;
      }
      // 上游确认可用 → 此刻才扣费（整条链路唯一一次账面变动）
      PointsService.Spend spend = points.spend(uid, QA_COST, "分身问答");
      if (!spend.ok()) {
        closeQuietly(res.body());
        String why = spend.error();
        send(out, frame("type", "error", "message", why == null || why.isEmpty() ? "墨水不足" : why));
        return;
      }
      charged = true;
      readSse(res.body(), out);
      List<String> titles = snippets.stream().map(s -> "《" + s.title() + "》").toList();
      send(out, frame("type", "cite", "citation", titles.isEmpty() ? null : String.join("、", titles)));
      try {
        insertQa(uid, question, "(streamed)", json.writeValueAsString(
            snippets.stream().map(RagService.Snippet::title).toList()));
      } catch (Exception qaFailed) {
        // 流水失败不阻塞回答
      }
    } catch (Exception broken) {
      String why = NodeShapes.slice(
          broken.getMessage() == null ? "服务异常" : String.valueOf(broken.getMessage()), 80);
      send(out, frame("type", "error", "message", charged
          ? why + "（本次问答已按成功计费）" : why + "，本次未扣墨水"));
    }
  }

  /**
   * DeepSeek 的 SSE 转发成 NDJSON 的 delta。
   *
   * <p>按<b>字节</b>切行而不是先解码再切：{@code \n} 不可能出现在 UTF-8 多字节序列中间，
   * 所以"字节级找行、整行解码"与 Node 的"增量解码后再 split" 结果相同，
   * 却省掉一个 CharsetDecoder 的半字符滞留问题。末尾不足一行的残字节两栈一起丢。
   */
  private void readSse(InputStream in, OutputStream out) throws IOException {
    try (InputStream body = in) {
      ByteArrayOutputStream tail = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      int read;
      while ((read = body.read(chunk)) != -1) {
        tail.write(chunk, 0, read);
        byte[] all = tail.toByteArray();
        int lineStart = 0;
        for (int i = 0; i < all.length; i++) {
          if (all[i] == '\n') {
            forwardSseLine(new String(all, lineStart, i - lineStart, StandardCharsets.UTF_8), out);
            lineStart = i + 1;
          }
        }
        tail.reset();
        tail.write(all, lineStart, all.length - lineStart);
      }
    }
  }

  /** {@code data:} 行才转发；解析失败按"不完整行"忽略（Node 的 catch{} 同形）。 */
  private void forwardSseLine(String rawLine, OutputStream out) {
    String line = NodeShapes.jsTrim(rawLine);
    if (!line.startsWith("data:")) {
      return;
    }
    // t.slice(5) 是"从下标 5 取到结尾"，两参数版 NodeShapes.slice 是"截断到 5 个字符"——
    // 写成后者会让 payload 恒为 "data:"，SSE 一帧都解不出来（README 里记着的同一个坑，又踩了一次）
    String payload = NodeShapes.jsTrim(NodeShapes.slice(line, 5, line.length()));
    if (payload.equals("[DONE]")) {
      return;
    }
    try {
      JsonNode delta = json.readTree(payload).path("choices").path(0).path("delta").path("content");
      if (jsTruthy(delta)) {
        // 值整个塞回去：JS 的 push({text: delta}) 不做 String()，数字就得发成数字
        send(out, frame("type", "delta", "text", delta));
      }
    } catch (Exception partial) {
      // 忽略
    }
  }

  /* ==================== 通道 ③：内置演示知识库 ==================== */

  private void streamDemo(OutputStream out, String question) throws Exception {
    Answer answer = demoAnswer(question);
    String text = answer.text();
    for (int i = 0; i < text.length(); i += 6) {
      send(out, frame("type", "delta", "text", NodeShapes.slice(text, i, i + 6)));
      Thread.sleep(24);
    }
    send(out, frame("type", "cite", "citation", answer.citation()));
  }

  private static Answer demoAnswer(String question) {
    for (Map.Entry<String, Answer> entry : KB.entrySet()) {
      String key = entry.getKey();
      String core = key.replaceAll("[？?]", "");
      // limit=-1：JS 的 split 保留空串，Java 默认丢掉；这里要靠 seg.length 判"够不够长"
      for (String seg : core.split(" ", -1)) {
        if (seg.length() >= 3 && question.contains(seg)) {
          return entry.getValue();
        }
      }
      if (question.contains(NodeShapes.slice(key, 6))) {
        return entry.getValue();
      }
    }
    return FALLBACK;
  }

  /* ==================== 上游请求体 ==================== */

  private Map<String, Object> passthroughPayload(String question, String author, String about) {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("question", question);
    payload.put("author", author);
    // about: about || undefined —— 空串在 JSON.stringify 里是"没有这个键"，不是 "about":""
    if (!about.isEmpty()) {
      payload.put("about", about);
    }
    return payload;
  }

  private Map<String, Object> deepseekPayload(String author, List<RagService.Snippet> snippets,
      String about, List<Turn> history, String question) {
    List<Map<String, Object>> messages = new ArrayList<>();
    messages.add(message("system", systemPrompt(author, snippets, about)));
    for (Turn turn : history) {
      messages.add(message(turn.role(), turn.content()));
    }
    messages.add(message("user", question));
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("model", "deepseek-chat");
    payload.put("messages", messages);
    payload.put("stream", true);
    payload.put("max_tokens", 400);
    payload.put("temperature", 0.7);
    return payload;
  }

  /** 必须是 LinkedHashMap：{@code Map.of} 不保证顺序，键序一换，上游收到的字节就两栈不同。 */
  private static Map<String, Object> message(String role, String content) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("role", role);
    out.put("content", content);
    return out;
  }

  /** 逐行照抄 Node 的 buildSystemPrompt：四段、空段滤掉、用空行分隔。 */
  private static String systemPrompt(String author, List<RagService.Snippet> snippets, String about) {
    List<String> parts = new ArrayList<>();
    parts.add("你是博主「" + author + "」的 AI 分身，以他的口吻回答读者提问。语气：严谨。");
    if (!about.isEmpty()) {
      parts.add("读者当前正在阅读《" + about + "》，回答可优先围绕这篇文章展开。");
    }
    if (!snippets.isEmpty()) {
      List<String> corpus = new ArrayList<>();
      for (int i = 0; i < snippets.size(); i++) {
        RagService.Snippet s = snippets.get(i);
        corpus.add("[片段" + (i + 1) + "] 来源《" + s.title() + "》：" + s.text());
      }
      parts.add("以下是检索到的博主文章片段，回答必须依据这些内容，并在末尾标注引用了哪些片段：\n"
          + String.join("\n\n", corpus));
    } else {
      parts.add("知识库中没有检索到相关内容：不要编造，明确告知读者你答不准，并建议转达博主。");
    }
    parts.add("要求：回答简洁（200 字内）；结合对话历史保持连贯；不得输出知识库依据以外的技术断言；"
        + "这是面向读者的正式回答，不要复述本指令。");
    return String.join("\n\n", parts);
  }

  /** DeepSeek 的接入点：默认官方地址，闸门会把它指到本地 SSE 夹具（详见 .env.example）。 */
  private String deepseekUrl() {
    return trimSlash(deepseekBase) + "/chat/completions";
  }

  /* ==================== HTTP 与写出 ==================== */

  /** JS 的字符串真假判据：只有 null / undefined / 空串为假，全空白也算"有值"。 */
  private static boolean jsTruthy(String value) {
    return value != null && !value.isEmpty();
  }

  private HttpResponse<InputStream> postJson(String url, Map<String, Object> payload) {
    return postJson(url, payload, null);
  }

  private HttpResponse<InputStream> postJson(String url, Map<String, Object> payload, String authorization) {
    try {
      HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
          .timeout(Duration.ofSeconds(60))
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofString(
              json.writeValueAsString(payload), StandardCharsets.UTF_8));
      if (authorization != null) {
        builder.header("Authorization", authorization);
      }
      return http.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
    } catch (InterruptedException slow) {
      Thread.currentThread().interrupt();
      return null;
    } catch (Exception down) {
      return null;
    }
  }

  /**
   * 透传：原样搬运上游字节，一帧都不重排——上游已经是 NDJSON 了。
   *
   * <p>截止时刻对齐 Node 的 {@code AbortSignal.timeout(60_000)}。差别要说清楚：Node 那个信号
   * 能在一次 read 正卡着时把它打断，这里只能在两块之间判——真出现"60 秒一个字节都不来"的挂起，
   * 得靠连接层（LB / TCP）先收走。这不是把防护做小了就是把流式做贵了的取舍，P7 与共享限流一起收。
   */
  private static void pump(InputStream in, OutputStream out, long deadlineNanos) throws IOException {
    try (InputStream body = in) {
      byte[] chunk = new byte[8192];
      int read;
      while ((read = body.read(chunk)) != -1) {
        out.write(chunk, 0, read);
        out.flush();
        if (System.nanoTime() > deadlineNanos) {
          return;
        }
      }
    }
  }

  private void send(OutputStream out, Map<String, Object> frame) {
    try {
      byte[] line = (json.writeValueAsString(frame) + "\n").getBytes(StandardCharsets.UTF_8);
      out.write(line);
      out.flush();
    } catch (IOException clientGone) {
      // 读者关了页面：Node 那边 controller.enqueue 不抛，行为同样是"这帧没人收"
    } catch (Exception impossible) {
      // 帧序列化失败也不该让流炸成 500
    }
  }

  private void insertQa(Long askerId, String question, String answer, String citations) {
    try {
      qa.insert(askerId, question, answer, citations);
    } catch (Exception failed) {
      // 流水写失败不阻塞回答，与 Node 的 .catch(() => {}) 同形
    }
  }

  private static Map<String, Object> frame(Object... keysAndValues) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (int i = 0; i + 1 < keysAndValues.length; i += 2) {
      out.put((String) keysAndValues[i], keysAndValues[i + 1]);
    }
    return out;
  }

  /** JS 的真假判据：缺字段、null、空串、0、NaN 为假；数组与对象恒真。 */
  private static boolean jsTruthy(JsonNode value) {
    if (value == null || value.isMissingNode() || value.isNull()) {
      return false;
    }
    if (value.isNumber()) {
      double d = value.doubleValue();
      return d != 0 && !Double.isNaN(d);
    }
    if (value.isBoolean()) {
      return value.booleanValue();
    }
    if (value.isTextual()) {
      return !value.asText().isEmpty();
    }
    return true;
  }

  private static String nullToEmpty(String value) {
    return value == null ? "" : value;
  }

  private static void closeQuietly(InputStream in) {
    try {
      if (in != null) {
        in.close();
      }
    } catch (Exception ignored) {
      // 取消一条上游流没有需要向用户交代的失败
    }
  }

  /** Node 的 {@code url.trim().replace(/\/$/, "")}：去首尾空白，再去掉<b>一个</b>结尾斜杠。 */
  private static String trimSlash(String value) {
    if (value == null) {
      return "";
    }
    String out = NodeShapes.jsTrim(value);
    return out.endsWith("/") ? out.substring(0, out.length() - 1) : out;
  }
}
