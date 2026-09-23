package com.inkstack.importer;

import com.inkstack.common.IpGuard;
import com.inkstack.common.NodeDates;
import com.inkstack.common.NodeShapes;
import com.inkstack.common.NodeUrl;
import com.inkstack.common.Slugs;
import com.inkstack.mapper.ImportMapper;
import java.io.IOException;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

/**
 * 博主迁移工具的服务端：抓取（含 SSRF 防护）+ 解析 + 逐条入库。
 *
 * <p>抓取这一段是本仓库里唯一"由用户指定目标地址并替用户发一次外呼"的地方，
 * 因此它的每一条拒绝文案都是安全边界的一部分：
 * 私网/环回/链路本地一律拒，重定向改为手动逐跳、<b>每一跳重新过一遍同一套校验</b>，
 * 最多 3 跳——否则攻击者用一个公网域名 302 到 {@code 169.254.169.254} 就能绕过黑名单，
 * 而失败文案 {@code 订阅源返回 ${status}} 会变成内网探活的 oracle。
 */
@Service
public class ImportService {

  /** 与 Node 的 {@code Outcome} 同形：状态码 + 响应体。 */
  public record Outcome(int status, Map<String, Object> body) {}

  private record Fetched(int status, String text) {}

  private static final int MAX_REDIRECTS = 3;
  /**
   * Node 的 {@code /^https?:\/\/.+/i.test(url)}——{@code test} 是"能否找到匹配"，
   * 而 {@code .} 不认换行，所以这里必须用 {@code find} 配一个字符类：
   * 用 {@code matches} 会让含换行的地址在 Java 被拒、在 Node 放行（WHATWG 先把 CR/LF 删掉再解析）。
   */
  private static final Pattern HTTP_SHAPED =
      Pattern.compile("^https?://[^\\r\\n]", Pattern.CASE_INSENSITIVE);
  private static final Pattern NAME_BLOCKED =
      Pattern.compile("^(localhost|.*\\.local|.*\\.internal)$", Pattern.CASE_INSENSITIVE);
  private static final Pattern CHARSET = Pattern.compile("charset=([^;\\s\"']+)", Pattern.CASE_INSENSITIVE);
  private static final SecureRandom RANDOM = new SecureRandom();

  private final ImportMapper articles;
  private final boolean allowPrivate;
  private final HttpClient http = HttpClient.newBuilder()
      .followRedirects(HttpClient.Redirect.NEVER)
      .connectTimeout(Duration.ofSeconds(8))
      .build();

  public ImportService(ImportMapper articles,
      @Value("${inkstack.import.allow-private:false}") boolean allowPrivate) {
    this.articles = articles;
    this.allowPrivate = allowPrivate;
  }

  /**
   * 主机名是否禁止抓取；返回拒绝原因，{@code null} 表示放行。
   *
   * <p>与 Node 一致：黑名单不看"字面 IP 还是域名"，主机名一律先解析（字面量地址由解析器原地返回），
   * 再按**全部** A/AAAA 结果判——只查其中一条就是 DNS 轮询下的漏网之鱼。
   */
  String blockedHost(String rawUrl) {
    if (allowPrivate) {
      return null;
    }
    NodeUrl.Url parsed = NodeUrl.parse(rawUrl);
    if (parsed == null) {
      return "RSS 地址无法解析";
    }
    String host = stripBrackets(parsed.host());
    if (NAME_BLOCKED.matcher(host).matches()) {
      return "禁止抓取内网/本机地址";
    }
    InetAddress[] addrs;
    try {
      addrs = InetAddress.getAllByName(host);
    } catch (UnknownHostException unparsable) {
      return "RSS 主机名无法解析，请确认地址可公开访问";
    }
    for (InetAddress addr : addrs) {
      if (IpGuard.isPrivate(addressBytes(addr))) {
        return "禁止抓取内网/环回地址（安全防护）";
      }
    }
    return null;
  }

  /**
   * IPv6 的字面量在 JDK 里可能以 IPv4 形态回来（{@code Inet4Address} 装 {@code ::ffff:x}），
   * 取原始字节最稳；映射地址交给 {@link IpGuard} 按尾四节的 IPv4 规则判。
   */
  private static byte[] addressBytes(InetAddress addr) {
    if (addr instanceof Inet6Address v6 && v6.isIPv4CompatibleAddress()) {
      byte[] raw = v6.getAddress();
      byte[] four = new byte[4];
      System.arraycopy(raw, 12, four, 0, 4);
      return four;
    }
    return addr.getAddress();
  }

  private static String stripBrackets(String host) {
    String out = host;
    if (out.startsWith("[")) {
      out = out.substring(1);
    }
    if (out.endsWith("]")) {
      out = out.substring(0, out.length() - 1);
    }
    return out;
  }

  /** 手动逐跳跟随重定向；返回 {@code text == null} 时 {@code status} 里装的是拒绝原因。 */
  private Fetched fetchFeed(String url) {
    String target = url;
    for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
      String blocked = blockedHost(target);
      if (blocked != null) {
        return refused(blocked);
      }
      URI uri;
      try {
        uri = URI.create(encodeSpaces(target));
      } catch (IllegalArgumentException malformed) {
        return refused("订阅源抓取失败，请确认地址可公开访问");
      }
      HttpResponse<byte[]> res;
      try {
        res = http.send(HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(15))
            .header("User-Agent", "InkStackBot/0.1 (+https://inkstack.dev)")
            .GET().build(), HttpResponse.BodyHandlers.ofByteArray());
      } catch (HttpTimeoutException slow) {
        return refused("订阅源抓取超时（15s）");
      } catch (IOException | InterruptedException down) {
        if (down instanceof InterruptedException) {
          Thread.currentThread().interrupt();
        }
        return refused("订阅源抓取失败，请确认地址可公开访问");
      }
      int status = res.statusCode();
      if (status >= 300 && status < 400) {
        String location = res.headers().firstValue("location").orElse(null);
        if (location == null || location.isEmpty()) {
          return refused("订阅源返回了无跳转目标的重定向（已拒绝）");
        }
        // 三条拒绝文案的先后顺序照抄 Node：先"绝对化失败"，再"协议不是 http(s)"，最后才是私网。
        // 顺序写错的表现为同一次攻击拿到不同文案——而这套防护的判定是**跨栈比对**出来的。
        String next = NodeUrl.resolve(target, location);
        if (next == null) {
          return refused("订阅源重定向地址无法解析（已拒绝）");
        }
        if (!httpPrefixed(next)) {
          return refused("订阅源重定向到非 http(s) 地址（已拒绝）");
        }
        if (NodeUrl.parse(next) == null) {
          return refused("订阅源重定向地址无法解析（已拒绝）");
        }
        target = next;
        continue;
      }
      return new Fetched(status, decode(res.body(),
          res.headers().firstValue("content-type").orElse("application/xml")));
    }
    return refused("订阅源跳转次数过多（>" + MAX_REDIRECTS + " 次），已拒绝");
  }

  private static Fetched refused(String reason) {
    return new Fetched(-1, reason);
  }

  /** Node 的 {@code /^https?:\/\//i.test(next)}：只看前缀，不要求整串匹配。 */
  private static boolean httpPrefixed(String value) {
    String head = value.length() > 8 ? value.substring(0, 8).toLowerCase() : value.toLowerCase();
    return head.startsWith("http://") || head.startsWith("https://");
  }

  /**
   * Location 头里出现裸空格在真实订阅源里并不罕见，而 {@code URI.create} 会直接抛。
   * WHATWG 的解析器是把空格 percent-encode 之后继续走——这里同式，否则两侧一个发得出请求、
   * 另一个回"抓取失败"。
   */
  private static String encodeSpaces(String url) {
    return url.indexOf(' ') < 0 ? url : url.replace(" ", "%20");
  }

  private static String decode(byte[] body, String contentType) {
    Matcher m = CHARSET.matcher(contentType);
    if (m.find()) {
      try {
        return new String(body, Charset.forName(m.group(1)));
      } catch (RuntimeException unsupported) {
        // 与 undici 一致：认不出的字符集退回 UTF-8
      }
    }
    return new String(body, StandardCharsets.UTF_8);
  }

  /**
   * RSS 分支：抓取 → 解析 → 入库。
   *
   * @return 成功时 {@code status=200}；失败时是各自的 400 文案
   */
  public Outcome rss(long uid, String rawUrl) {
    String url = NodeShapes.jsTrim(rawUrl == null ? "" : rawUrl);
    if (!HTTP_SHAPED.matcher(url).find()) {
      return bad("RSS 地址需以 http(s):// 开头");
    }
    String blocked = blockedHost(url);
    if (blocked != null) {
      return bad(blocked);
    }
    Fetched fetched = fetchFeed(url);
    if (fetched.status() < 200 || fetched.status() > 299) {
      if (fetched.status() == -1) {
        return bad(fetched.text());
      }
      return bad("订阅源返回 " + fetched.status() + "，请确认地址可公开访问");
    }
    String xml = fetched.text();
    if (xml.length() > Importer.MAX_XML) {
      return bad("订阅源过大（>2MB），请精简后再试");
    }
    List<Importer.Item> items = Importer.parseFeed(xml);
    if (items.isEmpty()) {
      return bad("未在订阅源中解析出文章（支持 RSS 2.0 / Atom）");
    }
    return ok("rss", store(uid, items));
  }

  /** Markdown 分支：文件已由 servlet 收好，这里只解析正文并入库。 */
  public Outcome markdown(long uid, List<Upload> files) {
    List<Importer.Item> items = new ArrayList<>();
    for (Upload file : files) {
      if (!Importer.markdownish(file.filename())) {
        items.add(skippedFile(file.filename()));
        continue;
      }
      if (file.bytes().length > Importer.MAX_MD_FILE) {
        items.add(skippedFile(file.filename()));
        continue;
      }
      items.add(Importer.parseMarkdownFile(
          new String(file.bytes(), StandardCharsets.UTF_8), file.filename()));
    }
    return ok("markdown", store(uid, items));
  }

  /** 一个待导入文件：只关心文件名与字节，与 Node 的 {@code File} 对应。 */
  public record Upload(String filename, byte[] bytes) {}

  /** 与 Node 同：非 .md/.markdown/.txt 或超 300KB 的文件走 __SKIP__ 哨兵。 */
  private static Importer.Item skippedFile(String filename) {
    return new Importer.Item("__SKIP__" + filename, "", "", null);
  }

  /** 入库：逐条判重 + slug 唯一化 + 撞键换号重试，一条失败不影响其它条（Node 同形）。 */
  private Stored store(long uid, List<Importer.Item> items) {
    List<Map<String, Object>> imported = new ArrayList<>();
    List<Map<String, Object>> skipped = new ArrayList<>();
    int seq = 1;
    for (Importer.Item item : items) {
      if (item.title().startsWith("__SKIP__")) {
        skipped.add(row("title", item.title().substring(8),
            "reason", "仅支持 .md/.markdown/.txt 且单文件 ≤300KB"));
        continue;
      }
      String title = NodeShapes.jsTrim(item.title());
      if (title.isEmpty() || NodeShapes.jsTrim(item.md()).isEmpty()) {
        skipped.add(row("title", title.isEmpty() ? "(无标题)" : title, "reason", "标题或正文为空"));
        continue;
      }
      if (articles.dupeId(uid, title) != null) {
        skipped.add(row("title", title, "reason", "你的账号下已有同名文章"));
        continue;
      }
      String slug = "";
      boolean saved = false;
      try {
        for (int attempt = 0; attempt < 6 && !saved; attempt++) {
          slug = uniqueSlug(Slugs.make(title, seq));
          try {
            articles.insert(uid, slug, title, item.md(), item.summary(), "[\"迁移\"]",
                NodeDates.toSqlLocal(
                    item.publishedAt() == null ? Instant.now() : item.publishedAt()));
            saved = true;
          } catch (DuplicateKeyException raced) {
            if (attempt >= 5) {
              throw raced;
            }
            // 中文名一律回退到 bo-日期-N，并发导入同名时必撞唯一键：换个号退避再试
            try {
              Thread.sleep(5 + RANDOM.nextInt(20) * (attempt + 1L));
            } catch (InterruptedException ignored) {
              Thread.currentThread().interrupt();
            }
          }
        }
        imported.add(row("title", title, "slug", slug));
        seq++;
      } catch (RuntimeException failed) {
        skipped.add(row("title", title, "reason", "入库失败（数据库异常）"));
      }
    }
    return new Stored(imported, skipped);
  }

  /** 两键响应行，键序与 Node 的对象字面量一致（{@code Map.of} 不保证顺序）。 */
  private static Map<String, Object> row(String k1, Object v1, String k2, Object v2) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put(k1, v1);
    out.put(k2, v2);
    return out;
  }

  private record Stored(List<Map<String, Object>> imported, List<Map<String, Object>> skipped) {}

  private String uniqueSlug(String base) {
    String candidate = base;
    int i = 2;
    while (articles.slugTaken(candidate) != null) {
      candidate = base + "-" + i++;
    }
    return candidate;
  }

  private Outcome ok(String source, Stored stored) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("source", source);
    body.put("imported", stored.imported().size());
    body.put("articles", stored.imported());
    body.put("skipped", stored.skipped());
    return new Outcome(200, body);
  }

  private static Outcome bad(String error) {
    return new Outcome(400, Map.of("error", error));
  }
}
