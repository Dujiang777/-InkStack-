package com.inkstack.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.agent.AvatarEngine;
import com.inkstack.common.NodeShapes;
import com.inkstack.points.PointsService;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * AI 写作助手（续写 / 润色 / 起标题 / 推荐选题），对应 {@code app/api/ai/write/route.ts}。
 *
 * <p>计费口径是这条链路的全部难点，而它的形态是"<b>只读探针预检 → 上游确认可用之后才扣</b>"：
 * 原实现曾走"先扣后生成、失败再退分"，退分本身一失败就永久丢墨，且模板兜底也照扣不误
 * （文案还谎报"已退回"）。现在钱只在真实产出那一刻动一次，不存在需要回滚的中间态——
 * 所以"上游返回了非空文本"与"扣款成功"这两件事的先后顺序<b>不能反</b>，
 * 反了就会出现"给了内容没收到钱"或"扣了钱给的是模板"。
 */
@Service
public class AiWriteService {

  public record Outcome(int status, Map<String, Object> body) {}

  private static final int MAX_DRAFT = 100_000;
  private static final Map<String, String> LABELS = Map.of(
      "continue", "续写", "polish", "润色", "title", "起标题", "topic", "推荐选题");
  private static final Map<String, Long> PRICES = Map.of(
      "continue", 15L, "polish", 10L, "title", 5L, "topic", 5L);
  /**
   * 演示模板：Python 服务不可用或非 live 时的兜底文本，与 Node 的 CONTENT <b>逐字节</b>一致。
   *
   * <p>这里刻意不用 text block：兜底文本的前导换行是内容的一部分（续写接在用户草稿后面、
   * 起标题是接在标签后面，所以第一条分别要两个和一个 {@code \n}），而 text block 的内容
   * 从开括号的下一行算起、还要做一次缩进剥离——"少一个换行"这种差异肉眼看不出来，
   * 只能靠闸门比出来。写成显式转义的普通字符串，能一眼对上。
   */
  private static final Map<String, String> CONTENT = Map.of(
      "continue",
      "\n\n具体展开之前，先给一个可复现的判据：用 EXPLAIN ANALYZE 跑一遍你的典型查询，"
          + "如果执行计划里 Filter 节点的耗时占比超过 40%，说明标量过滤正在大量「白检」"
          + "——向量算出来的相似度被业务条件扔掉了大半。这才是混合检索该出场的时候，"
          + "而不是矩阵里数字变大的那一刻。\n\n选型是知识问题，时机是成本问题。大部分团队死在后者。",
      "polish",
      "\n技术选型最大的陷阱，不是选错，而是拿着别人的规模做自己的决定。\n\n"
          + "文章不到一万篇时，pgvector 的 HNSW 索引足够把召回率压上 95%，查询耗时个位数毫秒。"
          + "此刻引入独立向量库，你收获的清单很确定：一个需要运维的有状态服务、一份新增的内存账单，"
          + "和每个新成员都要重读一遍的部署文档。\n\n规模没到，架构先行"
          + "——是用今天的确定性，为明天还不存在的问题付利息。",
      "title",
      "\n1. pgvector 够用了：别急着上专用向量库\n"
          + "2. 你的向量库焦虑，可能只是数据没到量级\n"
          + "3. 在引入专用向量库之前，请先跑一次 EXPLAIN ANALYZE\n"
          + "4. 一万篇以下，Postgres 就是最好的向量数据库\n"
          + "5. 向量库选型的真正分界线：不是数据量，是过滤耦合",
      "topic",
      "\n1. 为什么我把博客的检索从向量库换回了 MySQL 全文索引\n"
          + "2. 给 AI 分身喂了 20 篇旧文之后，它学会了我最坏的表达习惯\n"
          + "3. 个人博主的 RAG：从「能检索」到「敢引用」差了哪三步\n"
          + "4. 流式输出的体验设计：让读者等得起的前 300 毫秒\n"
          + "5. 博客平台的积分经济：为什么免费的 AI 一定被玩死");

  private final PointsService points;
  private final AvatarEngine engine;
  private final String agentServiceUrl;
  private final HttpClient http = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(8))
      .build();
  private final ObjectMapper json = new ObjectMapper();

  public AiWriteService(PointsService points, AvatarEngine engine,
      @Value("${inkstack.agent.service-url:}") String agentServiceUrl) {
    this.points = points;
    this.engine = engine;
    this.agentServiceUrl = agentServiceUrl;
  }

  /** 入参形状与 Node 同：坏 JSON 退化成空对象，由 mode 校验给出 400。 */
  public Outcome write(long uid, String mode, String rawDraft, String rawAuthor) {
    String key = mode == null ? "" : mode;
    if (!LABELS.containsKey(key)) {
      return bad("mode 须为 continue | polish | title | topic");
    }
    String draft = rawDraft == null ? "" : rawDraft;
    if (draft.length() > MAX_DRAFT) {
      return bad("草稿过长（上限 10 万字）");
    }
    draft = NodeShapes.jsTrim(draft);
    String author = NodeShapes.slice(NodeShapes.jsTrim(rawAuthor == null ? "博主" : rawAuthor), 40);
    long cost = PRICES.get(key);

    long balance = points.peekBalance(uid);
    if (balance < cost) {
      return new Outcome(402, Map.of("error", "积分不足（余额 " + balance + "，本次需 " + cost + "）"));
    }

    // 引擎优先：配了 Spring AI 就用它真生成；没配或它失败，再走 Python 透传，再落模板。
    String generated = engine.available() ? engine.write(key, writePrompt(key, draft), author) : null;
    if (generated == null) {
      generated = fromAgentService(key, draft, author);
    }
    if (generated != null) {
      PointsService.Spend spend = points.spend(uid, cost, "AI写作·" + LABELS.get(key));
      if (!spend.ok()) {
        return new Outcome(402, Map.of("error", spend.error()));
      }
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("label", LABELS.get(key));
      body.put("text", generated);
      body.put("aiGenerated", true);
      body.put("cost", cost);
      body.put("pointsNote", "已扣 " + cost + " 滴墨水 · 余额 " + spend.balance());
      return new Outcome(200, body);
    }

    // 模板兜底：内容不是真实生成的，一个墨点都不扣
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("label", LABELS.get(key));
    body.put("text", CONTENT.get(key));
    body.put("aiGenerated", true);
    body.put("cost", cost);
    body.put("pointsNote", "模板兜底 · 本次不扣墨水");
    body.put("fallback", true);
    return new Outcome(200, body);
  }

  /**
   * 问一次上游分身服务。返回 {@code null} 表示"没有可用产出"——服务没起、超时、
   * 状态码不是 2xx、text 是空串，全都算这一档，由调用方落模板兜底。
   */
  private String fromAgentService(String mode, String draft, String author) {
    String base = trimSlash(agentServiceUrl);
    if (base.isEmpty()) {
      return null;
    }
    try {
      // 键序必须与 Node 的 JSON.stringify 一致：Map.of 不保证顺序，上游收到的字节会两栈不同
      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("mode", mode);
      payload.put("draft", effectiveDraft(draft, author));
      payload.put("author", author);
      String body = json.writeValueAsString(payload);
      HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/ai/write"))
          .timeout(Duration.ofSeconds(90))
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
          .build();
      HttpResponse<byte[]> res = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
      if (res.statusCode() < 200 || res.statusCode() > 299) {
        return null;
      }
      JsonNode data = json.readTree(new String(res.body(), StandardCharsets.UTF_8));
      JsonNode text = data.get("text");
      if (text == null || !text.isTextual() || NodeShapes.jsTrim(text.asText()).isEmpty()) {
        return null;
      }
      return text.asText();
    } catch (InterruptedException slow) {
      Thread.currentThread().interrupt();
      return null;
    } catch (Exception down) {
      // 服务未启动 / 超时 / 返回不是 JSON：与 Node 的 catch{} 同形，一律落模板
      return null;
    }
  }

  private static String trimSlash(String url) {
    if (url == null) {
      return "";
    }
    String out = NodeShapes.jsTrim(url);
    return out.endsWith("/") ? out.substring(0, out.length() - 1) : out;
  }

  private static Outcome bad(String error) {
    return new Outcome(400, Map.of("error", error));
  }

  /** 草稿为空时替它拼一条主题占位：两条生成通道共用同一个"有效草稿"。 */
  private static String effectiveDraft(String draft, String author) {
    return draft.isEmpty() ? "（作者尚未写下草稿，主题：" + author + " 的技术专栏）" : draft;
  }

  /**
   * 四档提示词，前三档逐字照抄 Python 服务的 WRITE_PROMPTS，topic 是按同一句式补齐的
   * （Python 版没有 topic，遇到它回 400，Node 就落模板——那是缺档，不是有意的行为）。
   * 送进模型的草稿裁到 3000 字，与 Python 的 {@code draft[:3000]} 同口径。
   */
  private static String writePrompt(String mode, String draft) {
    String body = NodeShapes.slice(draft, 3000);
    return switch (mode) {
      case "continue" -> "续写这段草稿（300 字内），延续作者的论证节奏与口吻，只输出续写内容：\n\n" + body;
      case "polish" -> "润色这段草稿：保留原意与观点，收紧节奏、删冗余，只输出润色后的文本：\n\n" + body;
      case "title" -> "为这段草稿起 5 个中文标题，每行一个，风格克制不标题党：\n\n" + body;
      default -> "推荐 5 个适合这位博主的选题，每行一个，须与其既有文章方向一致：\n\n" + body;
    };
  }
}
