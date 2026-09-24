package com.inkstack.db;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import javax.sql.DataSource;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

/**
 * 启动时把 {@code db/schema.sql} 的 DDL 应用到当前数据源。
 *
 * <p>为什么 Java 侧要有这个：双轨期建库是 Node 顺手做的（{@code lib/data.ts} 里那批
 * {@code ensure*Table/ensure*Columns} 在第一次用到时把表建出来）。P7 要把 Node 侧的 SQL 删干净，
 * 那时"谁来建库"只剩一个答案。这一档先把它补上，否则删 Node SQL 的第一天，一份新库谁都建不起来。
 *
 * <p><b>只有一份定义。</b>脚本不打进 jar 的副本、不另抄一份，而是 Maven 打包时把仓库根的
 * {@code db/schema.sql} 拷进 classpath（见 pom 的 {@code <resources>}）——两份定义早晚会漂移，
 * 而漂移的第一种表现是"新库缺某张表"，最难查。闸门 16 拿空库真起一次进程来钉这条链路。
 *
 * <p><b>幂等姿势照 Node：报错就势继续，不拖垮启动。</b>脚本是历史长出来的（同一列可能既在
 * {@code CREATE TABLE} 里又在后面的 {@code ALTER} 里），在一份已经建好的库上必然撞上
 * "已经存在"。这类按错误码放行；<i>其它</i>错误记 WARN 后继续——一个权限收紧的 DB 用户不该因为
 * 建不了某张表就整个站起不来，那会让"升级后端"变成"停站"。代价是真出问题时不会大声失败，
 * 所以收尾把计数打在日志里，并由闸门 16 用结构比对来兜（形状不对就是红，不靠日志）。
 *
 * <p><b>种子数据一律不跑。</b>脚本里有两条 {@code INSERT INTO users/articles}（演示博主与占位稿），
 * 建库执行器只认 {@code CREATE}/{@code ALTER}。造演示内容是有意识的动作，归
 * {@code npm run seed}，不该发生在每次进程启动的路上。
 */
@Component
public class SchemaBootstrap {

  private static final Logger log = LoggerFactory.getLogger(SchemaBootstrap.class);

  /** MySQL 的"已经有了"：1050 表存在、1060 列存在、1061 索引/键名存在、1091 要删的不存在、1826 外键重复。 */
  private static final Set<Integer> ALREADY_THERE = Set.of(1050, 1060, 1061, 1091, 1826);

  private final DataSource dataSource;
  private final ResourceLoader resources;
  private final boolean enabled;
  private final String location;

  public SchemaBootstrap(DataSource dataSource, ResourceLoader resources,
      @Value("${inkstack.schema.auto:true}") boolean enabled,
      @Value("${inkstack.schema.location:classpath:db/schema.sql}") String location) {
    this.dataSource = dataSource;
    this.resources = resources;
    this.enabled = enabled;
    this.location = location;
  }

  /**
   * 用 {@code @PostConstruct} 而不是 {@code ApplicationRunner}：后者跑在 Web 容器已经就绪之后，
   * 那中间会有一段"端口已开、表还没有"的窗口。放在 Bean 初始化阶段，空库的第一个请求才不会
   * 抢到建库前面。
   */
  @PostConstruct
  public void bootstrap() {
    if (!enabled) {
      log.info("建库开关关闭（inkstack.schema.auto=false）：表结构交给外部迁移");
      return;
    }
    String script;
    try (InputStream in = resources.getResource(location).getInputStream()) {
      script = new String(in.readAllBytes(), StandardCharsets.UTF_8);
    } catch (Exception unreadable) {
      log.error("读不到建库脚本 {}（{}）——本轮跳过建库，请检查打包是否把 db/schema.sql 带进了 classpath",
          location, unreadable.getMessage());
      return;
    }
    List<String> statements = ddlStatements(script);
    int applied = 0;
    int already = 0;
    List<String> failed = new ArrayList<>();
    try (Connection conn = dataSource.getConnection(); Statement st = conn.createStatement()) {
      for (String one : statements) {
        try {
          st.execute(one);
          applied++;
        } catch (SQLException boom) {
          if (isAlreadyThere(boom)) {
            already++;
          } else {
            failed.add(head(one) + " ← " + boom.getMessage());
          }
        }
      }
    } catch (SQLException unreachable) {
      log.error("建库连不上数据源：{} —— 跳过建库，进程照常启动（Node 侧的懒迁移同样是「连不上就继续」）",
          unreachable.getMessage());
      return;
    }
    log.info("建库脚本 {}：DDL {} 条，执行 {} 条，已存在放行 {} 条，失败 {} 条",
        location, statements.size(), applied, already, failed.size());
    for (String one : failed) {
      log.warn("建库有一条没成：{}", one);
    }
  }

  /**
   * 从脚本里挑出可执行的 DDL。
   *
   * <p>分句必须<b>带引号状态机</b>：文章正文与 COMMENT 里都有分号，按 {@code split(";")} 会切出
   * 半截语句，剩下的部分再按首词一判，就可能把一段本该跳过的种子内容当 DDL 执行。
   * 同样按首词只留 {@code CREATE}/{@code ALTER}：{@code CREATE DATABASE} 与 {@code USE}
   * 会把会话切到别的库去（这条真踩过），{@code INSERT}/{@code SET} 是种子，都不该在这里跑。
   */
  static List<String> ddlStatements(String script) {
    List<String> out = new ArrayList<>();
    for (String raw : splitStatements(script)) {
      String one = raw.trim();
      String upper = one.toUpperCase();
      if (one.isEmpty() || !(upper.startsWith("CREATE TABLE") || upper.startsWith("ALTER TABLE"))) {
        continue;
      }
      out.add(one);
    }
    return out;
  }

  /**
   * 按"不在引号、不在注释里的分号"切句，并<b>在切的过程中就把注释丢掉</b>。
   *
   * <p>注释不能等切完再按行删：块注释收尾那一行前面残留的半截文本会让首词不再是 CREATE，
   * 于是这条语句被当垃圾跳过——错的方式不是抛异常，而是少建一张表（这个 bug 就是单测抓的）。
   * MySQL 的 {@code ''} 与反斜杠转义都算在字符串内，所以字符串里的分号也不会误切。
   */
  private static List<String> splitStatements(String script) {
    List<String> out = new ArrayList<>();
    StringBuilder cur = new StringBuilder();
    char quote = 0;
    boolean lineComment = false;
    boolean blockComment = false;
    for (int i = 0; i < script.length(); i++) {
      char c = script.charAt(i);
      char next = i + 1 < script.length() ? script.charAt(i + 1) : 0;
      if (lineComment) {
        if (c == '\n') {
          lineComment = false;
          cur.append(c);            // 换行留下，免得注释把下一条语句黏在一起
        }
        continue;
      }
      if (blockComment) {
        if (c == '*' && next == '/') {
          i++;
          blockComment = false;
          cur.append(' ');
        }
        continue;
      }
      if (quote != 0) {
        cur.append(c);
        if (c == '\\' && next != 0) {          // 反斜杠转义：下一个字符无条件算字符串内容
          cur.append(next);
          i++;
        } else if (c == quote && next == quote) { // '' 形式的引号自转义
          cur.append(next);
          i++;
        } else if (c == quote) {
          quote = 0;
        }
        continue;
      }
      if (c == '\'' || c == '"' || c == '`') {
        quote = c;
        cur.append(c);
        continue;
      }
      // MySQL 的行注释是 "-- 后接空白**或行尾**"。漏掉行尾这一支，一行光秃秃的 `--`
      // 就会被当成语句正文留在下一块的开头，首词判据接着把下面整条 CREATE 丢掉。
      if (c == '-' && next == '-' && (i + 2 >= script.length() || endsLineOrSpace(script.charAt(i + 2)))) {
        lineComment = true;
        continue;
      }
      if (c == '#') {
        lineComment = true;
        continue;
      }
      if (c == '/' && next == '*') {
        blockComment = true;
        i++;
        continue;
      }
      if (c == ';') {
        out.add(cur.toString());
        cur.setLength(0);
        continue;
      }
      cur.append(c);
    }
    if (!cur.toString().isBlank()) {
      out.add(cur.toString());
    }
    return out;
  }

  /** 沿 SQLException 链找厂商错误码——MySQL 把"已存在"包在链上而不是首节点。 */
  private static boolean isAlreadyThere(SQLException boom) {
    for (SQLException e = boom; e != null; e = e.getNextException()) {
      if (ALREADY_THERE.contains(e.getErrorCode())) {
        return true;
      }
    }
    return false;
  }

  /** {@code --} 之后允许的东西：空白、又一个 {@code -}（{@code ---} 这种），或直接到行尾。 */
  private static boolean endsLineOrSpace(char c) {
    return c == ' ' || c == '\t' || c == '-' || c == '\n' || c == '\r';
  }

  private static String head(String statement) {
    String one = statement.replaceAll("\\s+", " ").trim();
    return one.length() <= 70 ? one : one.substring(0, 70) + "…";
  }
}
