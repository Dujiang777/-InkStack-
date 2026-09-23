package com.inkstack.importer;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.Part;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 博主迁移工具入口：{@code application/json} 走 RSS 抓取，{@code multipart/form-data} 走 Markdown 批量。
 *
 * <p>Node 侧那两个 503 分支（演示模式无 MySQL）在这里没有对位实现：Java 后端启动即要求数据库，
 * 不存在"跑着但没有库"的状态，所以照搬会把一条永不成立的分支写进代码。
 * 坏 JSON 的姿势要留意——它落的是 {@code 抓取/解析失败，请检查内容格式}，
 * 与书房那批接口的 {@code 请求格式有误} 不是同一条：Node 把这个分支写在覆盖整段解析的 try 里。
 */
@RestController
public class ImportController {

  private static final String MALFORMED = "抓取/解析失败，请检查内容格式";

  private final ImportService importer;

  public ImportController(ImportService importer) {
    this.importer = importer;
  }

  @PostMapping("/api/import")
  public ResponseEntity<Map<String, Object>> handle(
      @Current SessionUser me, HttpServletRequest request) {
    if (me == null) {
      return status(401, Map.of("error", "登录后才能使用迁移工具（文章导入到你自己的账号）"));
    }
    String contentType = request.getContentType() == null ? "" : request.getContentType();
    ImportService.Outcome outcome;
    if (contentType.contains("application/json")) {
      JsonNode body = Bodies.strictJson(request);
      if (body == null) {
        return status(400, Map.of("error", MALFORMED));
      }
      outcome = importer.rss(me.id(), urlOf(body));
    } else if (contentType.contains("multipart/form-data")) {
      List<ImportService.Upload> files;
      try {
        files = mdFiles(request);
      } catch (IOException | RuntimeException unparsable) {
        return status(400, Map.of("error", MALFORMED));
      }
      if (files.isEmpty()) {
        return status(400, Map.of("error", "未收到 .md 文件"));
      }
      if (files.size() > Importer.MAX_ITEMS) {
        return status(400, Map.of("error", "一次最多导入 " + Importer.MAX_ITEMS + " 个文件"));
      }
      outcome = importer.markdown(me.id(), files);
    } else {
      return status(400, Map.of("error",
          "Content-Type 须为 application/json（RSS）或 multipart/form-data（Markdown）"));
    }
    return status(outcome.status(), outcome.body());
  }

  /** {@code String(body.url ?? "").trim()}：非对象体（数组 / 标量）取不到键，等价于没传。 */
  private static String urlOf(JsonNode body) {
    JsonNode url = body.get("url");
    if (url == null || url.isNull()) {
      return "";
    }
    return Bodies.stringOf(url);
  }

  /** {@code form.getAll("files").filter(f => f instanceof File)}：普通表单字段不算文件。 */
  private static List<ImportService.Upload> mdFiles(HttpServletRequest request) throws IOException {
    List<ImportService.Upload> out = new ArrayList<>();
    try {
      for (Part part : request.getParts()) {
        String name = part.getSubmittedFileName();
        if ("files".equals(part.getName()) && name != null && !name.isEmpty()) {
          out.add(new ImportService.Upload(name, part.getInputStream().readAllBytes()));
        }
      }
    } catch (jakarta.servlet.ServletException malformed) {
      throw new IOException(malformed);
    }
    return out;
  }

  private static ResponseEntity<Map<String, Object>> status(int code, Map<String, Object> body) {
    return ResponseEntity.status(code).body(body);
  }
}
