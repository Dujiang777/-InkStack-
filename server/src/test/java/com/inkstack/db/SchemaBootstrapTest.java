package com.inkstack.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 建库脚本的分句与筛选。这块值得单测，因为它错的方式不是"抛异常"而是"少建一张表"：
 * 分号判错会把一条语句劈成两半，首词判错会把种子 INSERT 当成 DDL 跑掉。
 */
class SchemaBootstrapTest {

  @Test
  void 只留建表与改表其余一概不跑() {
    List<String> out = SchemaBootstrap.ddlStatements("""
        CREATE DATABASE IF NOT EXISTS inkstack DEFAULT CHARACTER SET utf8mb4;
        USE inkstack;
        CREATE TABLE IF NOT EXISTS users (id BIGINT) ENGINE=InnoDB;
        INSERT INTO users (id) VALUES (1);
        SET @chenyu = (SELECT id FROM users WHERE id = 1);
        ALTER TABLE users ADD COLUMN banned TINYINT(1) NOT NULL DEFAULT 0;
        """);
    assertEquals(2, out.size(), "CREATE DATABASE / USE / INSERT / SET 都不该出现在执行清单里");
    assertTrue(out.get(0).startsWith("CREATE TABLE"));
    assertTrue(out.get(1).startsWith("ALTER TABLE"));
  }

  @Test
  void 字符串与注释里的分号不算句末() {
    List<String> out = SchemaBootstrap.ddlStatements("""
        -- 分号在注释里; 也不该切句
        CREATE TABLE IF NOT EXISTS t (
          c VARCHAR(8) NOT NULL DEFAULT ';' COMMENT '带分号; 的说明',
          d VARCHAR(8) NOT NULL DEFAULT '\\''
        ) ENGINE=InnoDB;
        CREATE TABLE IF NOT EXISTS u (id BIGINT) ENGINE=InnoDB;
        """);
    assertEquals(2, out.size(), "一条 CREATE 被劈成两半的话，剩下的半截连首词都不是 CREATE，会静默少建表");
    assertTrue(out.get(0).contains("ENGINE=InnoDB"), out.get(0));
    assertTrue(out.get(0).contains("'\\''"), "反斜杠转义的引号必须还在同一条语句里：" + out.get(0));
  }

  @Test
  void 注释行不混进要执行的语句() {
    List<String> out = SchemaBootstrap.ddlStatements("""
        /* 块注释
           跨行 */
        CREATE TABLE IF NOT EXISTS t (
          -- 行注释
          id BIGINT
        ) ENGINE=InnoDB;
        """);
    assertEquals(1, out.size());
    assertTrue(out.get(0).startsWith("CREATE TABLE"));
    assertTrue(!out.get(0).contains("行注释") && !out.get(0).contains("块注释"), out.get(0));
  }

  @Test
  void 两个减号后直接换行也是注释() {
    // 这条是真踩过的：脚本里有一整行只写 "--" 当视觉分隔。它若被当成正文，就会留在下一块的开头，
    // 于是紧随其后的 CREATE TABLE 因为"首词不是 CREATE"被整条丢掉——少建一张表，而且不报错。
    List<String> out = SchemaBootstrap.ddlStatements(
        "CREATE TABLE IF NOT EXISTS a (id BIGINT);\n--\nCREATE TABLE IF NOT EXISTS b (id BIGINT);\n");
    assertEquals(2, out.size());
    assertTrue(out.get(1).startsWith("CREATE TABLE IF NOT EXISTS b"), out.get(1));
  }

  /**
   * 上面四条是语义，这一条是<b>真脚本</b>：分句器在合成样例上对、在 400 行的实际文件上把某条
   * CREATE 吞掉，是完全可能的（而表现是"新库少一张表"，要等用到才炸）。所以拿打包进
   * classpath 的那份原文数一遍。
   */
  @Test
  void 真脚本里的每一条建表都进了执行清单() throws Exception {
    String script;
    try (var in = SchemaBootstrapTest.class.getResourceAsStream("/db/schema.sql")) {
      script = new String(java.util.Objects.requireNonNull(in, "classpath 里没有 db/schema.sql").readAllBytes(),
          java.nio.charset.StandardCharsets.UTF_8);
    }
    List<String> out = SchemaBootstrap.ddlStatements(script);
    // 逐表比而不是只数条数：吞了哪条必须能一眼看出来（数出来的 30 与挑出来的 29 差在哪，
    // 只报数字的话还得再跑一遍才知道）
    var body = script.replaceAll("(?m)^\\s*--.*$", "");
    var want = new java.util.TreeSet<String>();
    var m = java.util.regex.Pattern.compile("CREATE TABLE IF NOT EXISTS (\\w+)").matcher(body);
    while (m.find()) {
      want.add(m.group(1));
    }
    var got = new java.util.TreeSet<String>();
    var p = java.util.regex.Pattern.compile("CREATE TABLE IF NOT EXISTS (\\w+)");
    for (String one : out) {
      var mm = p.matcher(one);
      if (mm.find()) {
        got.add(mm.group(1));
      }
    }
    want.removeAll(got);
    assertTrue(want.isEmpty(), "这些表没进执行清单（分句或首词判据吞了语句）：" + want);
    assertTrue(out.stream().noneMatch(s -> s.toUpperCase().startsWith("INSERT")),
        "种子 INSERT 不许出现在执行清单里");
    assertTrue(out.stream().noneMatch(s -> s.toUpperCase().startsWith("USE")),
        "USE 会决定语句落到哪个库上，绝不执行");
    assertTrue(out.stream().noneMatch(s -> s.toUpperCase().startsWith("CREATE DATABASE")),
        "建库交给部署，脚本里那句 CREATE DATABASE 不执行");
    assertTrue(out.stream().anyMatch(s -> s.contains("comment_likes")),
        "comment_likes 是 Node 懒迁移补出来的，必须已经收进脚本并被清单收走");
  }
}
