package com.inkstack.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inkstack.common.Nicknames;
import com.inkstack.entity.User;
import com.inkstack.mail.Mailer;
import com.inkstack.mapper.UserMapper;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * 第三方登录（GitHub / Gitee / QQ 互联）的"换 token → 拉资料 → upsert 本地账号"三段。
 *
 * <p>三条不变量，都是原实现踩过的坑：
 * <ol>
 *   <li><b>只信 primary 且 verified 的邮箱</b>。未验证邮箱一律不采信，走 noreply 兜底——
 *       否则任何人都能在第三方平台把邮箱字段填成受害者地址，再用"同邮箱即同一账号"的
 *       upsert 规则接管对方的本地账号。</li>
 *   <li><b>昵称必须净化后再入库/发信</b>。三家返回的 nickname/name/login 完全不受我方控制，
 *       而它会进欢迎邮件的 Subject 与 HTML 正文。</li>
 *   <li><b>OAuth 账号的密码槽写随机串</b>，不是写空：空哈希会让"用空密码登录"这种
 *       畸形请求有命中可能，随机串则永远验不过，直到用户在安全中心主动改密建立凭据。</li>
 * </ol>
 *
 * <p>redirect_uri 的基准与 Node v15.2 之后一致：<b>优先 site-url</b>，未配置才回退请求 origin。
 * 反代下 Java 看到的 host 是内部地址，所以生产必须显式配 NEXT_PUBLIC_SITE_URL（Node 同理）。
 */
@Service
public class OauthService {

  /** 一次回调的结果：either 成功（uid + 是否新建档 + 昵称/邮箱），either 失败原因（用于 302 回 /login?err=）。 */
  public record Result(String failure, Long uid, boolean created, String nickname, String email) {

    public static Result fail(String reason) {
      return new Result(reason, null, false, null, null);
    }

    public static Result logIn(long uid, boolean created, String nickname, String email) {
      return new Result(null, uid, created, nickname, email);
    }
  }

  private record Creds(String id, String secret) {
    boolean configured() {
      return id != null && !id.isBlank() && secret != null && !secret.isBlank();
    }
  }

  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
  private final ObjectMapper mapper = new ObjectMapper();
  private final SecureRandom random = new SecureRandom();
  private final UserMapper users;
  private final Mailer mailer;
  private final String siteUrl;

  private final Creds github;
  private final Creds gitee;
  private final Creds qq;

  public OauthService(UserMapper users, Mailer mailer,
      @Value("${inkstack.site-url:}") String siteUrl,
      @Value("${inkstack.oauth.github.client-id:}") String ghId,
      @Value("${inkstack.oauth.github.client-secret:}") String ghSecret,
      @Value("${inkstack.oauth.gitee.client-id:}") String gtId,
      @Value("${inkstack.oauth.gitee.client-secret:}") String gtSecret,
      @Value("${inkstack.oauth.qq.client-id:}") String qqId,
      @Value("${inkstack.oauth.qq.client-secret:}") String qqSecret) {
    this.users = users;
    this.mailer = mailer;
    this.siteUrl = siteUrl == null ? "" : siteUrl.trim();
    this.github = new Creds(ghId, ghSecret);
    this.gitee = new Creds(gtId, gtSecret);
    this.qq = new Creds(qqId, qqSecret);
  }

  public boolean enabled(String provider) {
    return switch (provider) {
      case "github" -> github.configured();
      case "gitee" -> gitee.configured();
      case "qq" -> qq.configured();
      default -> false;
    };
  }

  /** 随机 state：由控制器写进 provider 专属 Cookie，回调比对后即焚。 */
  public String newState() {
    byte[] raw = new byte[16];
    random.nextBytes(raw);
    StringBuilder sb = new StringBuilder();
    for (byte b : raw) {
      sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
    }
    return sb.toString();
  }

  /** 授权页 URL。参数顺序与 Node 版逐一对齐（比对不了顺序，但排错了容易看漏差异）。 */
  public String authorizeUrl(String provider, String state, String redirectUri) {
    List<String[]> params = new ArrayList<>();
    switch (provider) {
      case "github" -> {
        params.add(new String[] {"client_id", github.id()});
        params.add(new String[] {"redirect_uri", redirectUri});
        params.add(new String[] {"scope", "read:user user:email"});
        params.add(new String[] {"state", state});
        return "https://github.com/login/oauth/authorize?" + query(params);
      }
      case "gitee" -> {
        params.add(new String[] {"client_id", gitee.id()});
        params.add(new String[] {"redirect_uri", redirectUri});
        params.add(new String[] {"response_type", "code"});
        params.add(new String[] {"scope", "user_info emails"});
        params.add(new String[] {"state", state});
        return "https://gitee.com/oauth/authorize?" + query(params);
      }
      default -> {
        params.add(new String[] {"response_type", "code"});
        params.add(new String[] {"client_id", qq.id()});
        params.add(new String[] {"redirect_uri", redirectUri});
        params.add(new String[] {"state", state});
        return "https://graph.qq.com/oauth2.0/authorize?" + query(params);
      }
    }
  }

  /** 回调的 redirect_uri 基准：site-url 优先（生产），否则用请求自己的 origin（仅本机直连有效）。 */
  public String callbackBase(String provider, String requestOrigin, String callbackPath) {
    String base = siteUrl.isBlank() ? requestOrigin : trimTrailingSlash(siteUrl);
    return base + callbackPath;
  }

  /** provider 对应的 state Cookie 名——三家各一枚，避免同时授权两家时互相覆盖。 */
  public static String stateCookie(String provider) {
    return switch (provider) {
      case "github" -> "gh_oauth_state";
      case "gitee" -> "gt_oauth_state";
      default -> "qq_oauth_state";
    };
  }

  public Result callback(String provider, String code, String redirectUri) {
    try {
      return switch (provider) {
        case "github" -> githubFlow(code, redirectUri);
        case "gitee" -> giteeFlow(code, redirectUri);
        default -> qqFlow(code, redirectUri);
      };
    } catch (Exception e) {
      return Result.fail("network");
    }
  }

  private Result githubFlow(String code, String redirectUri) throws Exception {
    JsonNode token = postJson("https://github.com/login/oauth/access_token", Map.of(
        "client_id", github.id(), "client_secret", github.secret(), "code", code,
        "redirect_uri", redirectUri), "application/json");
    String accessToken = text(token, "access_token");
    if (accessToken.isEmpty()) {
      return Result.fail("token");
    }
    Map<String, String> auth = Map.of(
        "Authorization", "Bearer " + accessToken,
        "Accept", "application/vnd.github+json",
        "User-Agent", "inkstack");
    JsonNode gh = getJson("https://api.github.com/user", auth);
    String login = text(gh, "login");
    String id = text(gh, "id");
    if (login.isEmpty() || id.isEmpty()) {
      return Result.fail("profile");
    }
    String primary = "";
    JsonNode emails = getJson("https://api.github.com/user/emails", auth);
    if (emails.isArray()) {
      for (JsonNode e : emails) {
        if (e.path("primary").asBoolean(false) && e.path("verified").asBoolean(false)) {
          primary = text(e, "email");
          break;
        }
      }
    }
    String email = primary.isEmpty() ? id + "+" + login + "@users.noreply.github.com" : primary;
    return upsert(login, text(gh, "name"), text(gh, "bio"), email);
  }

  private Result giteeFlow(String code, String redirectUri) throws Exception {
    JsonNode token = postJson("https://gitee.com/oauth/token", Map.of(
        "client_id", gitee.id(), "client_secret", gitee.secret(), "code", code,
        "grant_type", "authorization_code", "redirect_uri", redirectUri), "application/json");
    String accessToken = text(token, "access_token");
    if (accessToken.isEmpty()) {
      return Result.fail("token");
    }
    String auth = URLEncoder.encode(accessToken, StandardCharsets.UTF_8);
    JsonNode ge = getJson("https://gitee.com/api/v5/user?access_token=" + auth, Map.of());
    String login = text(ge, "login");
    String id = text(ge, "id");
    if (login.isEmpty() || id.isEmpty()) {
      return Result.fail("profile");
    }
    String primary = text(ge, "email");
    JsonNode emails = tryJson("https://gitee.com/api/v5/emails?access_token=" + auth);
    boolean emailsOk = emails != null;
    if (emailsOk && emails.isArray()) {
      // 只信 primary 且 verified===true：未验证邮箱一律不采信，防用第三方邮箱字段接管本地账号
      for (JsonNode e : emails) {
        if (e.path("primary").asBoolean(false) && e.path("verified").asBoolean(false)) {
          primary = text(e, "email");
          break;
        }
      }
    }
    if (!primary.isEmpty() && !emailsOk) {
      // profile 里带的邮箱没有任何验证佐证，一律视为未验证 → 走 noreply 兜底
      primary = "";
    }
    String email = primary.isEmpty() ? id + "+" + login + "@users.noreply.gitee.com" : primary;
    return upsert(login, text(ge, "name"), text(ge, "bio"), email);
  }

  private Result qqFlow(String code, String redirectUri) throws Exception {
    String tokenUrl = "https://graph.qq.com/oauth2.0/token?" + query(List.of(
        new String[] {"grant_type", "authorization_code"},
        new String[] {"client_id", qq.id()},
        new String[] {"client_secret", qq.secret()},
        new String[] {"code", code},
        new String[] {"redirect_uri", redirectUri},
        new String[] {"fmt", "json"}));
    String tokenText = body(tokenUrl);
    String accessToken = jsonOrUrlencoded(tokenText, "access_token");
    if (accessToken.isEmpty()) {
      return Result.fail("token");
    }
    String meText = body("https://graph.qq.com/oauth2.0/me?access_token="
        + URLEncoder.encode(accessToken, StandardCharsets.UTF_8) + "&fmt=json");
    String openid = jsonOrUrlencoded(meText, "openid");
    if (openid.isEmpty()) {
      // QQ 偶发回 jsonp 包裹（callback(...)），从串里抠出 openid 兜底
      var m = java.util.regex.Pattern.compile("\"openid\"\\s*:\\s*\"([0-9a-fA-F]+)\"").matcher(meText);
      openid = m.find() ? m.group(1) : "";
    }
    if (openid.isEmpty()) {
      return Result.fail("profile");
    }
    JsonNode info = getJson("https://graph.qq.com/user/get_user_info?" + query(List.of(
        new String[] {"access_token", accessToken},
        new String[] {"oauth_consumer_key", qq.id()},
        new String[] {"openid", openid})), Map.of());
    if (info.path("ret").asInt(-1) != 0) {
      return Result.fail("profile");
    }
    String nickname = text(info, "nickname");
    if (nickname.isEmpty()) {
      nickname = "QQ用户" + (openid.length() > 6 ? openid.substring(0, 6) : openid);
    }
    String clean = Nicknames.clean(nickname);
    // QQ 不给邮箱：openid 对同一应用恒定，用它拼唯一兜底邮箱保证可复登同一账号
    String email = openid + "@qq.noreply.inkstack.dev";
    return persist(clean, email, clean.isEmpty() ? "" : clean.substring(0, 1).toUpperCase(), "", false);
  }

  private Result upsert(String login, String name, String bio, String email) {
    String nickname = Nicknames.clean(name.isEmpty() ? login : name);
    String avatarText = nickname.isEmpty() ? "" : nickname.substring(0, 1).toUpperCase();
    String safeBio = bio.length() > 250 ? bio.substring(0, 250) : bio;
    return persist(nickname, email, avatarText, safeBio, true);
  }

  private Result persist(String nickname, String email, String avatarText, String bio, boolean withBio) {
    String hash = "oauth:" + randomHex(24);
    int affected = withBio
        ? users.upsertOauth(nickname, email, hash, avatarText, bio)
        : users.upsertOauthNoBio(nickname, email, hash, avatarText);
    // MySQL：插入=1、更新且确有变化=2、更新但值相同=0；只有 1 才是"新建档"
    boolean created = affected == 1;
    // 两种分支都回查：ON DUPLICATE KEY 下自增键不可靠（更新分支根本不产生新值），
    // 唯一键 email 才是稳定的定位方式。
    Long uid = users.idByEmail(email);
    if (uid == null) {
      return Result.fail("db");
    }
    if (created) {
      Mailer sender = mailer;
      java.util.concurrent.CompletableFuture.runAsync(() -> sender.sendWelcome(email, nickname));
    }
    return Result.logIn(uid, created, nickname, email);
  }

  /* ---------- 小工具 ---------- */

  private JsonNode getJson(String url, Map<String, String> headers) throws Exception {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(8)).GET();
    headers.forEach(b::header);
    HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    return mapper.readTree(res.body());
  }

  private JsonNode tryJson(String url) {
    try {
      HttpResponse<String> res = http.send(
          HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(8)).GET().build(),
          HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
      if (res.statusCode() / 100 != 2) {
        return null;
      }
      return mapper.readTree(res.body());
    } catch (Exception e) {
      return null;
    }
  }

  private JsonNode postJson(String url, Map<String, String> payload, String accept) throws Exception {
    String body = mapper.writeValueAsString(payload);
    HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(8))
            .header("Content-Type", "application/json")
            .header("Accept", accept)
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    return mapper.readTree(res.body());
  }

  private String body(String url) throws Exception {
    return http.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(8)).GET().build(),
        HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();
  }

  /** QQ 的 token/me 既可能回 JSON 也可能回 urlencoded，两样都兜（与 Node 同）。 */
  private String jsonOrUrlencoded(String text, String field) {
    try {
      return text(mapper.readTree(text), field);
    } catch (Exception notJson) {
      String[] parts = text.split("&");
      for (String part : parts) {
        String[] kv = part.split("=", 2);
        if (kv.length == 2 && kv[0].equals(field)) {
          return URLDecoder.decode(kv[1], StandardCharsets.UTF_8);
        }
      }
      return "";
    }
  }

  private static String text(JsonNode node, String field) {
    JsonNode v = node == null ? null : node.path(field);
    return v == null || v.isMissingNode() || v.isNull() ? "" : v.asText();
  }

  private static String query(List<String[]> params) {
    StringBuilder sb = new StringBuilder();
    for (String[] kv : params) {
      if (sb.length() > 0) {
        sb.append('&');
      }
      sb.append(URLEncoder.encode(kv[0], StandardCharsets.UTF_8))
          .append('=')
          .append(URLEncoder.encode(kv[1] == null ? "" : kv[1], StandardCharsets.UTF_8));
    }
    return sb.toString();
  }

  private static String trimTrailingSlash(String value) {
    return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
  }

  private String randomHex(int bytes) {
    byte[] raw = new byte[bytes];
    random.nextBytes(raw);
    StringBuilder sb = new StringBuilder();
    for (byte b : raw) {
      sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
    }
    return sb.toString();
  }
}
