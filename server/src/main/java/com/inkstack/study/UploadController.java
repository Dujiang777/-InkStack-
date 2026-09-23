package com.inkstack.study;

import com.inkstack.mapper.UploadMapper;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.Part;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 图片上传（创作台插图）。
 *
 * <p>不信客户端声明的 MIME：白名单只决定"允许哪四类"，真实类型由**文件头魔数**判定，
 * 两者必须一致，否则一个改了扩展名的 HTML/脚本就能混进静态目录并被直接伺服。
 * 校验顺序也照搬 Node——先判类型（415）再判大小（413），反过来会让用户先看到体积错误。
 */
@RestController
public class UploadController {

  private static final Map<String, String> ALLOWED = Map.of(
      "image/png", "png",
      "image/jpeg", "jpg",
      "image/gif", "gif",
      "image/webp", "webp");

  private static final long MAX_SIZE = 5L * 1024 * 1024;
  private static final SecureRandom RANDOM = new SecureRandom();

  private final UploadMapper uploads;
  private final String uploadDir;

  public UploadController(
      UploadMapper uploads, @Value("${inkstack.upload-dir:public/uploads}") String uploadDir) {
    this.uploads = uploads;
    this.uploadDir = uploadDir;
  }

  @PostMapping("/api/uploads")
  public ResponseEntity<Map<String, Object>> upload(
      @Current SessionUser me, HttpServletRequest request) throws IOException {
    if (me == null) {
      return ResponseEntity.status(401).body(Map.of("error", "登录后才能上传图片"));
    }
    Part file = filePart(request);
    if (file == null) {
      return ResponseEntity.badRequest().body(Map.of("error", "缺少 file 字段"));
    }
    // File#type 按规范是去掉参数的小写 MIME；Servlet 的 getContentType 会带上 "; charset=…"
    String mime = declaredType(file.getContentType());
    String ext = ALLOWED.get(mime);
    if (ext == null) {
      return ResponseEntity.status(415).body(Map.of("error", "仅支持 png / jpg / gif / webp"));
    }
    if (file.getSize() > MAX_SIZE) {
      return ResponseEntity.status(413).body(Map.of("error", "图片不能超过 5MB"));
    }
    byte[] buf = file.getInputStream().readAllBytes();
    if (!ext.equals(sniff(buf))) {
      return ResponseEntity.status(415).body(Map.of("error", "文件内容与声明类型不符"));
    }

    String name = System.currentTimeMillis() + "-" + hex4() + "." + ext;
    Path dir = Path.of(uploadDir);
    Files.createDirectories(dir);
    Files.write(dir.resolve(name), buf);

    try {
      uploads.register(me.id(), name, mime, buf.length);
    } catch (RuntimeException ignored) {
      // 登记失败不影响已经落盘的文件，与 Node 的 fire-and-forget 同
    }
    return ResponseEntity.ok(Map.of("ok", true, "url", "/uploads/" + name));
  }

  private static Part filePart(HttpServletRequest request) {
    try {
      for (Part part : request.getParts()) {
        if ("file".equals(part.getName()) && isRealFile(part)) {
          return part;
        }
      }
      return null;
    } catch (IOException | IllegalStateException unparsable) {
      // Node 的 formData() 失败退化成 null，同样回"缺少 file 字段"
      return null;
    } catch (jakarta.servlet.ServletException malformed) {
      return null;
    }
  }

  /** 一个普通表单字段不是 File：Node 用 {@code file instanceof File} 判，这里看有没有文件名。 */
  private static boolean isRealFile(Part part) {
    String filename = part.getSubmittedFileName();
    return filename != null && !filename.isEmpty();
  }

  private static String declaredType(String raw) {
    if (raw == null) {
      return "";
    }
    int semicolon = raw.indexOf(';');
    return (semicolon < 0 ? raw : raw.substring(0, semicolon)).trim().toLowerCase();
  }

  /** 文件头魔数。不足 12 字节的"图片"一律算不符——真图不可能这么小。 */
  private static String sniff(byte[] buf) {
    if (buf.length < 12) {
      return "";
    }
    if (u8(buf, 0) == 0x89 && u8(buf, 1) == 0x50 && u8(buf, 2) == 0x4E && u8(buf, 3) == 0x47) {
      return "png";
    }
    if (u8(buf, 0) == 0xFF && u8(buf, 1) == 0xD8 && u8(buf, 2) == 0xFF) {
      return "jpg";
    }
    if (u8(buf, 0) == 0x47 && u8(buf, 1) == 0x49 && u8(buf, 2) == 0x46) {
      return "gif";
    }
    if (ascii(buf, 0, 4).equals("RIFF") && ascii(buf, 8, 12).equals("WEBP")) {
      return "webp";
    }
    return "";
  }

  private static int u8(byte[] buf, int i) {
    return buf[i] & 0xFF;
  }

  private static String ascii(byte[] buf, int from, int to) {
    return new String(buf, from, to - from, java.nio.charset.StandardCharsets.US_ASCII);
  }

  private static String hex4() {
    byte[] salt = new byte[4];
    RANDOM.nextBytes(salt);
    return HexFormat.of().formatHex(salt);
  }
}
