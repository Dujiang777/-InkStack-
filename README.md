# 墨栈 InkStack · Java 换栈版（渐进双轨进行中）

> 博主有 AI 分身、读者能和文章对话、创作能变现、平台自己会运营。
> 本仓库是 [Next.js 单体版 inkstack](https://gitee.com/du-jiangjiang/inkstack) 的**后端换栈工作副本**：
> 后端逐模块迁到 **Spring Boot 全家桶**，前端 Next.js 原样保留，两套后端在同一份数据库上并行运行、逐接口对拍验证。

| | |
|---|---|
| Gitee | <https://gitee.com/du-jiangjiang/ink-stack-java> |
| GitHub | <https://github.com/Dujiang777/-InkStack-> |

**为什么是"双轨"而不是一次重写**：原项目已有线上站点在跑，换栈必须做到每个模块都能与旧实现
逐字段比对、并且改一个环境变量就能回滚。所以这里的形态是——Java 先把某一类接口实现到与 Node
完全等价，对拍 diff 归零后再切流量，切完再动下一类。任一时刻站点都是可用的。

---

## 📌 迁移进度

| 阶段 | 内容 | 状态 | 验收 |
|---|---|---|---|
| P0 | `server/` 工程立骨：Boot 3.5.16 + MyBatis-Plus + MySQL 连通 | ✅ | `mvn compile` 通过，`/actuator/health` UP |
| P1 | 会话互通：HMAC Cookie + scrypt + sessions 表 + 登录/登出/me | ✅ | **双向 Cookie 互通 8/8** |
| P2 | 双轨对拍闸门 + middleware 按模块切流 | ✅ | 切流/回滚实测通过 |
| P3 | 只读内容模块（列表 / 详情 / 搜索 / 热榜 / 归档…） | ✅ | 读侧 27 个函数全切；**11 页 × 4 身份 44/44 逐字一致**，检索防泄漏探针 4/4 |
| P1b | 认证剩余端点（注册 / 邮箱验证码 / 重置 / 2FA / 改密 / 设备管理 / OAuth） | ✅ | 跨栈认证流程 **25/25**（一侧签发、另一侧消费），切流代理 10/10 |
| P4 | 墨水经济（充值 / 打赏 / 解锁 / 打包 / 加热 / 签到 / 徽章） | ✅ | 资金闸门 **100/100**：六路跨栈并发双击零 500、`Δ余额 = ΔΣ流水` 精确成立、幂等分支跨栈一致；切流代理含资金路径 **16/16** |
| P5a | 社区互动写侧（评论 / 点赞 / 收藏 / 关注 / 举报 / 站内信） | ✅ | 社区闸门 **108/108**（连跑三轮全绿）：并发举报只落 1 行、`like_count = 关系行数` 守恒、奖励日上限拒了不吞额度；切流代理含社区路径 **24/24** |
| P5b | 创作台写侧（发布 / 存草稿 / 草稿转正 / 更新重审 / 撤回 / 硬删） | ✅ | 创作台闸门 **51/51**：8 路并发同名标题零 500 且 slug 互不相同、审核归属只认 Cookie 里的 role、草稿硬删连子表一并清 |
| P5c | 运营台（内容审核 / 评论删除 / 举报处理 / 用户管理）+ 两个全文出口 `{slug}/raw`、`{slug}/export` | ✅ | 运营台闸门 **65/65**：四条接口逐个 401/403、下架连带清置顶、扣回按真实余额记账、导出正文两侧逐字一致且不泄漏后端端口；切流代理含运营台路径 **31/31** |
| P5d | 书房写侧（草稿箱 / 阅读足迹 / 外链审核 / 资料 / 改密 / 图片上传 / 专栏增删改） | ✅ | 书房闸门 **97/97**：门禁姿势逐个钉住（友链游客是 403 不是 401、足迹游客是 200 skipped）、昵称按 JS 空白判据折叠、上传两栈共用同一磁盘目录、12 路跨栈并发重设篇目零 500 且条目守恒；切流代理含书房路径 **41/41**（含 multipart 穿过 rewrite） |
| P5e | 博主迁移工具 `POST /api/import`（RSS 抓取 + Markdown 批量导入） | ✅ | 迁移闸门 **100/100**：SSRF 私网黑名单的十几种写法（十进制 / 十六进制 / 八进制 / 短写 / 全角句号 / userinfo 掩护 / IPv4 映射）两侧同码同文案、重定向逐跳复校、消毒七条正则的产物逐字比库、RFC 1123 各家日期落进同一个本地墙钟；切流代理含迁移工具 **48/48** |
| P6a | AI 写作助手 `POST /api/ai/write` + 分身状态 `GET /api/agent/status` | ✅ | AI 闸门 **41/41**：四段兜底模板逐字节相同、"上游真产出才扣墨"两侧同式（探针拦住 → 上游 0 次、上游坏态 → 零扣墨且落同一份模板）、数字/数组/对象入参转发给上游的字符串两边同式、六路并发 40→10 只有两路成功、`流水条数 == 扣费次数`；切流代理含 AI 路径 **54/54** |
| P6b | 分身问答 `POST /api/agent/ask`（NDJSON 流式，三条通道） | ✅ | 三条通道逐个钉：透传**分块到达**（代理不攒包）、SSE 只放行 content 帧、演示档游客可问且零扣墨；上游 503 → error 帧同文案零扣墨、吐两帧再掐线 → 明说"本次已按成功计费"；DeepSeek 收到的请求体两栈逐字一致（system prompt 里就是 RAG 挑出的那几段）。AI 闸门 **63/63**、切流代理 **56/56** |
| P6c | Spring AI 智能体顶掉 Python 的 `agent-service/`（已删除） | ✅ | 引擎闸门 **20/20**：ReAct 那一圈真的转（模型先拿工具清单、第二轮带工具结果继续）、检索语料带付费墙与审核闸门（Python 版两条都缺，逐条对照钉死）、切块宽度与 cite 抽取照原实现、上游 502/空白一律落演示档零扣墨、`AGENT_MODEL_*` 决定徽标档位 |
| P7a | 解除 `/api/series` 的跨栈语义冲突，整前缀切流 | ✅ | 书房闸门 **117/117**（新增 17 项：三条 URL 逐个逐字节对拍，含 `limit`/`author` 的 11 种取值与 6 种 id 形态）、切流代理 **56/56**（原来那条"必须仍在 Node"的反向断言翻成正向：前缀下每个 URL 每个方法都要带 `x-backend`）；闸门 8 现算出的最长可切前缀已经是 **`/api`**（Node 58 个 URL 模式全部被 Java 覆盖、方法集合零差异、语义冲突登记表已空） |
| P7b | 建库收进 Java 进程（`SchemaBootstrap`），Node 侧懒建表/加列从此有了对等物 | ✅ | 建库闸门 **15/15**：对着三个空临时库真起 `spring-boot:run`，建出来的表/列/类型/可空性/默认值/索引/外键与「手工应用 `db/schema.sql`」逐条一致，并覆盖运行库每一张表；0 用户 0 文章（建库不越界造演示数据）；同库再起一次表数列数一条不变（幂等）；`INKSTACK_SCHEMA_AUTO=false` 时一张表都不建、接口确实应不上 |
| P7 | 收尾：web 退化为纯渲染层，删除 Node 侧 SQL | ⏳ | — |

当前由 Java 应答的接口（`JAVA_ROUTES` 留空时**全部仍由 Node 应答**，行为与原版一致）：

- 认证：`POST /api/auth/login|logout|register|send-code|reset` · `GET /api/auth/me|providers`
  · `GET /api/auth/{github,gitee,qq}` 与三家 `/{p}/callback` · `GET /api/auth/github/status`
- 安全中心：`POST /api/security/password` · `GET|DELETE /api/security/sessions`
  · `POST|PUT|DELETE /api/security/2fa`
- 内容：`GET /api/articles` · `GET /api/articles/{slug}` · `GET /api/search`
- 墨水经济：`POST /api/articles/{slug}/unlock|tip|boost` · `POST /api/series/{id}/bundle`
  · `GET|POST /api/checkin` · `POST /api/me/badge-claim` · `GET|POST /api/topup/orders`
  · `POST /api/topup/pay`（这一组只能按段通配逐条切，见"切流与回滚"）
- 社区互动：`GET|POST /api/articles/{slug}/comments` · `POST /api/articles/{slug}/like|bookmark|report|paywall-view`
  · `POST /api/comments/{id}/like|report` · `POST /api/users/{id}/follow` · `GET /api/notifications`
  · `POST /api/notifications/read`
- 创作台：`POST /api/articles` · `PUT|DELETE /api/articles/{slug}` · `GET /api/articles/{slug}/raw`
  · `GET /api/articles/{slug}/export`（至此 `/api/articles` **整前缀**在 Java 上方法集合已齐，
  闸门 8 现算出的可整体切流前缀包含它）
- 运营台：`POST /api/admin/articles|comments|reports|users`（内容管理与审核、删评论连带回复、
  举报三种处置、封禁与点墨增减；`setRole` 两栈都只认 developer，admin 也一样 403）
- 书房：`GET|PUT /api/drafts` · `POST /api/history` · `GET|POST|PUT /api/links`
  · `PATCH /api/me/profile` · `PATCH /api/me/password` · `POST /api/uploads`
  · `GET|POST /api/series` · `GET|PATCH|DELETE /api/series/{id}` · `GET /api/series/mine`
  · `POST /api/series/{id}/bundle`（P5d 时这四条**已实现却切不过去**：切流只有前缀粒度，
  而 `GET /api/series` 两栈同 URL 同方法却不同义——Node 是"我的专栏"
  （`components/StudioClient.tsx` 正在吃它），Java 是公开合集架。P6d 把两件事拆成两条 URL：
  Node 的 `GET /api/series` 对齐成公开架、另开 `GET /api/series/mine`，前端改读新 URL，
  整前缀这才切得动，见闸门 8 与闸门 10 §7.5）
- 迁移工具：`POST /api/import`（RSS 用 JSON、Markdown 用 multipart，同一个 URL 两种体）
  —— 全平台唯一一处"由用户给地址、服务端替他联网"的入口，SSRF 防护见闸门 13
- AI 面：`POST /api/ai/write` · `POST /api/agent/ask` · `GET /api/agent/status`。P6b 之后
  `/api/agent` 与 `/api/ai` 两个前缀都**整前缀安全**（闸门 8 现算，判定已从"存在缺口"翻成"无缺口"）。
  问答是 NDJSON 流式，切过去之后仍然逐块吐帧（闸门 6 有一项专门盯这个：代理把响应攒成一坨，
  功能不坏但前端从打字机变成"等十几秒再整篇砸脸"）
- 只读聚合（为 RSC 分流新增）：`/api/articles/{slug}/comments|tips|saved|series-nav`、
  `/api/users/{id}/relation`、`/api/tags/{tag}/articles`、`/api/authors/{id}[/articles]`、
  `/api/weekly/stats`、`/api/random`、`/api/me/*` 十项。它们中的大部分 Node 侧至今无对位路由
  （页面直连 `lib/data.ts` 取数，没有 HTTP 入口），只有 `/api/series` 那一族在 P7a 之后两栈都有了

移植过程中修掉的既有 bug（有的在原实现里就存在，有的差一点就跟着移植过去；对拍要求两侧同口径，
所以一律两边一起改）：

- `listAchievements` 把 mysql2 返回的 `Date` 直接 `String(date).slice(0, 10)` 当日期键，得到的是
  `"Mon Sep "` 而不是 `"2026-09-14"`，与查询键永不相等 → 连签徽章恒为 0、集齐奖励领不到。
  改成本地日历日键 `localDayKey()`（DATE 列回来是"本地零点的 Date"，不能用 `toISOString()`，那会早一天）。
- 同函数里 `num(results[4])` 按默认列名 `"n"` 取值，而 `results[4]` 的列是 `points_balance`，
  恒得 `undefined → 0`，"墨水富翁"徽章因此永远算不出来。
- 同键并发插入 InnoDB 未必回 dup key，也可能回死锁 / 锁等待超时，两侧原先都把它当"签到失败"返回。
  现按 `isRetryableLockError` 重试三次（30ms×attempt），Node 与 Java 用同一套口径。
  点赞链路上撞到了同一件事（`SELECT..FOR UPDATE` 在未命中的主键上取的是 gap 锁，两个并发事务
  各持一把再去插入就成环），故 Java 的 `retryOnLock` 与 Node 点赞路由用同样的三次退避。
- **Java 的 `String.trim()` 与 JS 的不是一个东西**：`trim()` 只裁 `<=U+0020`，全角空格 `U+3000`
  裁不掉；`strip()` 走 `Character.isWhitespace`，又不认 `U+00A0` 与 `U+FEFF`。于是一条"纯全角空格"
  的评论在 Node 是「内容不能为空」、在 Java 会正常落库。已补 `NodeShapes.jsTrim()` 按 JS 判据裁。
- 举报的防重锚点曾被写在**事务外**（`submit(id, type, db.lockArticleAnchor(slug), reason)`——参数在
  进 `tx.execute` 之前就已求值，那句 `FOR UPDATE` 自动提交、取到锁立刻放掉），六路并发于是落两行。
  现在锚点以 `Supplier` 传进事务内执行。这类"看着只是风格"的差别，只有并发打才暴露，
  而 `reports` 表上没有 `(reporter,target)` 唯一索引，没有任何第二道兜底。
- 导出 Markdown 的 `md.trim()` 同样栽在上一条那个坑里：Java 的 `trim()` 留着全角空格与 BOM 开头，
  两侧导出的字节就差在那里。已改 `NodeShapes.jsTrim()`。
- **DATETIME 不是 UTC**：mysql2 按**驱动本地时区**解释库里的 `DATETIME`（实测 `+08` 机器上
  `'2030-01-02 03:04:05'` → `2030-01-01T19:04:05.000Z`），Node 再 `toISOString()` 吐回。
  Java 必须落在同一个瞬间上——两侧读的都是 `2030-01-01T19:04:05.000Z`，
  而"库里存的串就是 UTC"这个直觉会把早鸟到点整体推后一个时区。
- **`affectedRows` 在两栈默认值下不是同一个数**：Connector/J 给连接打上 `CLIENT_FOUND_ROWS`，
  UPDATE 回的是"匹配几行"；mysql2 没打这个标志，回的是"真正改动几行"。同一句 no-op UPDATE
  （把 `bundle_price` 改成它当前的值）Node 拿 0、Java 拿 1，而工程里到处拿 affectedRows 当
  "这行到底存不存在 / 是不是新建"的判据。已在全局生成 JDBC 串时补 `useAffectedRows=true`。
  顺带一处证据：`OauthService` 里 `created = affected == 1` 那句注释写的就是 affectedRows 语义——
  默认值下它会把"老用户第 N 次登录"读成"刚建档"并补发欢迎邮件。
  这个洞是书房闸门拿"改专栏打包价"逼出来的：跨栈比 `GET` 回来的价格一致、写回的却是两个世界。
- **JS 的 `slice` 会夹取，Java 的 `substring` 会抛**：生成 TOTP 备份码时，6 字节 base64url 是 8 个字符，
  去掉 `-` / `_` 之后长度掉到 5~8，于是 `token.substring(4, 8)` 在长度 7 时抛
  `begin 4, end 8, length 7`。按原写法实测**每四次"开启两步验证"就有一次 500**（22.7%），
  而 Node 侧同一句 `slice(4, 8)` 只是安静地给出一个短一点的码。已补 `NodeShapes.slice(value, from, to)`
  并在此后所有"从 Node 抄来的切片"处使用。这类差异不会出现在对拍里——它取决于随机数。
- **SSRF 黑名单栽在"字符串前缀判"上**（写闸门 13 时抓到的真实绕过，两栈原本都有）：
  `[::ffff:192.168.1.2]` 经过 `new URL()` 会被压成 `[::ffff:c0a8:102]`，而原实现判映射地址是
  "取 `::ffff:` 之后的子串按 IPv4 正则匹配"——那子串是十六进制，正则不命中就当公网放行，
  实测一个 200 打到了本机网卡地址。十进制 `2130706433`、十六进制、八进制、`127.1`、
  全角句号 `127。1`、userinfo 掩护这些写法同理：只要有一种在某一侧被判成"域名"丢进 DNS，
  整条黑名单就失效。现在两侧都把地址解析成**字节**再判（Node 在 `route.ts` 里、Java 在 `IpGuard` 里），
  并且 Java 自带了一个 WHATWG 口径的地址解析器 `NodeUrl`——`java.net.URI` 与 `java.net.URL`
  都不做 IPv4 归一化，不能拿来当判据用。
- **V8 认识 RFC 1123，`java.time` 不认识**：RSS 的 `pubDate` 是 `Mon, 23 Sep 2026 08:00:00 GMT`，
  移植时若只留 ISO 分支，Java 会把每一条日期判成"解析失败"，于是**全部**导入稿都落到
  "导入时刻"兜底分支——两侧都有日期、都不报错，只有值不一样。补分支时要连 V8 的怪癖一起补：
  两位年（0-49 归 2000 段、50-99 归 1900 段）、星期名不参与校验、缺时区按本地而 ISO 纯日期按 UTC。
- **`NodeShapes.slice` 的两种签名又绊了一次**：JS 的 `title.slice(8)`（从下标 8 到结尾）被写成
  单参数的 `slice(value, 8)`（那是 `slice(0, 8)`），于是"剥掉 `__SKIP__` 前缀"变成"只留前 8 个字符"，
  回给用户的文件名成了 `__SKIP__`。与备份码那次的 `substring(4, 8)` 是同一类：从 Node 抄切片时，
  先确认它是"截断"还是"取尾"。
- **消毒正则少写一个 `+`**：未加引号的属性值那条分支 `[^\s>]+` 写成了 `[^\s>]`，Java 只吃掉一个字符，
  `<img src="a.png" onerror=alert(1)>` 就留下 `<img src="a.png"lert(1)>` 这种残骸——
  比"没消毒"更糟，因为它骗过了肉眼。这一条由"两栈各导一轮再逐列比库"报出来，
  顺带确认了一件事：**每一条从 Node 抄来的正则都要过一遍 `Java \s ≠ JS \s` 这个筛子**，
  消毒、标签匹配、空白折叠三处都在筛子上重写过。
- Windows 上 `.properties` 里的反斜杠是转义符：`INKSTACK_UPLOAD_DIR=D:\Desktop\...\uploads`
  会让 `\u` 成为一个畸形的统一码转义，**JVM 在解析配置阶段就起不来**（`ConfigDataException`），
  报的还不是路径问题。生成脚本现在统一 `replace(/\\/g, "/")`。
- **`body.author ?? "博主"` 的默认值，在 JSON 解析层就没了**：Java 侧把缺字段先映射成 `""` 再进业务，
  于是 `(author == null ? "博主" : author)` 永不成立，转发给上游的 `author` 成了空串——
  Node 给的是"博主"。这种差异两侧都不报错，只有生成的文风不一样，而且它藏在"没传 author"这条
  平时没人测的路径上（AI 闸门第一轮 4 红里就有它）。规则：**可选字段的默认值必须在"键不存在"这个
  层面上判**，所以 `AiWriteController.authorOf()` 缺键返回 `null` 而不是 `""`。
- **同一处默认值修完之后，另一半是 Node 会 500 而 Java 不会**：`draft`/`author` 在 JSON 里可以是
  数字、数组、对象，Node 的 `(body.draft ?? "").trim()` 对 `{draft: 5}` 就是一个未捕获的
  `TypeError` → 500，而 Java 按 `String()` 口径安静地收成 `"5"`。真实用户不会发这种 body，
  但**切流的那一刻状态码会变**，这属于闸门 8 说的"切过去会静默改变行为"。所以两边一起改向不崩的那一侧
  （Node 补 `String(...)`），并让闸门 14 拿"上游收到的字符串"来断言——那是这个口径唯一可见的地方。
  P6b 的 `question`/`author`/`about` 是同一条规矩，一并收口。
- **流式接口的返回类型写成 `ResponseEntity<?>` 会让 Spring 拒收你的流，而且是在扣款之后**：
  `StreamingResponseBodyReturnValueHandler` 看的是**声明的**泛型参数，通配 `?` 不算数，于是流式体
  被当成普通返回值去找 JSON 转换器，报 `No converter for …Lambda…` → 500。这条链路在返回之前
  就已经扣过 5 点墨了，所以失败形态是最糟的那种：**钱扣了、一个字都没给读者**。返回类型必须
  字面写成 `ResponseEntity<StreamingResponseBody>`（闸门 14 的演示通道第一轮整段红就是它）。
- **`slice` 的两种签名第三次绊人，`Map.of` 又不守键序**：JS 的 `t.slice(5)`（取下标 5 到结尾）
  又写成了两参数版 `NodeShapes.slice(line, 5)`（截断到 5 个字符），于是 SSE 的 payload 恒为
  `"data:"`、一帧 delta 都解不出来，而末尾的 cite 帧照发——"流看起来是通的，就是没有内容"。
  同一个文件里转发给 DeepSeek 的消息用 `Map.of("role",…,"content",…)`，`Map.of` 不保证顺序，
  两侧发给上游的 JSON 键序就不一样（语义相同、字节不同，夹具一比就露）。规则补两条：
  从 Node 抄切片先定它是"截断"还是"取尾"；**凡是要把字节交给别人的 Map，一律 LinkedHashMap**。
- **Spring AI 的 starter 会替"每种模型"都装 Bean，而没配 Key 时直接把整个应用炸掉**：
  实测启动失败的原因不是聊天模型，是 `OpenAiAudioSpeechAutoConfiguration` 的语音合成 Bean
  （"OpenAI API key must be set"）。一个部署不需要语音，却要被它的可选 Bean 拦住启动，
  所以 `spring.ai.model.*` 一律设成 `none`，由 `AvatarEngine` 自己按"开关 + 有没有 Key"构造
  ChatModel——没 Key 的部署照样起得来，并照旧落模板兜底。
- **Spring AI 自带的指数退避重试把一次 502 拖成四分钟**（2s / 10s / 50s / 180s 各撞一次超时）：
  一个 Tomcat 线程被占死，远超读者等分身回答的 60 秒预算，而 Node 那条 live 通道本来就是一次
  fetch 定生死。引擎侧显式 `RetryTemplate.maxAttempts(1)`，与参照实现同口径——**框架的默认值
  不是"更安全"的选项**，它只是另一个人的默认值。
- **被删掉的那台 Python 服务，检索 SQL 缺两道判定**：它的 `search_blog_articles` 只过
  `status='published'`，既不看 `review_status='approved'` 也不看付费墙，于是"读者花 5 点墨问一句、
  分身把没解锁的付费正文念出来"这条 P3 时代就堵掉的洞，在智能体这一侧一直开着。引擎按
  `lib/rag.ts` 的口径重做，闸门 15 用"旧 SQL 查得到 vs 引擎没发给模型"成对钉住它。
- **派生配置时写空串，会静默吃掉 Spring 的占位符回落**：`application.yml` 里写的是
  `${AGENT_MODEL_API_KEY:${DEEPSEEK_API_KEY:}}`，可 `gen-java-env` 只要在 properties 里留下
  一行 `AGENT_MODEL_API_KEY=`，A 就算"已定义"、回落不再生效——运营照 DEPLOY.md 只填一个 Key，
  引擎却因为空串没起来，而徽标照样报 `live`（它确实有 Key，只是走的不是引擎）。规则补一条：
  **派生脚本只写有值的行，回落链在脚本里判空，不要留给占位符语法**。
- **「与分身问答 10 次」这枚徽章从来没可能拿到**（原实现自带的 bug，两栈同错）：`agent_qa` 建表时
  有 `asker_id`，成就与 `badge-claim` 也都按 `COUNT(*) FROM agent_qa WHERE asker_id = ?` 算，
  可两条 INSERT 语句一条都没写这一列——全是 NULL，进度恒为 0。**两侧一起错的对拍自然看不见**，
  这一条是读 SQL 读出来的。现在三条通道（透传 / live / 引擎）都落 `asker_id`，
  闸门 14 §8 §9 与闸门 15 §4 各钉一条"流水挂得上提问者"。
- **一条 URL 干两件事，切流就切不动**（`GET /api/series`）：Node 侧它是书房的"我的专栏"
  （要登录、回 `{ok,series}`），Java 侧它是公开合集架（匿名、回另一套形状）。**两侧各自都没有 bug**，
  所以对拍是绿的、页面是好的、接口测试全过——只有"把 `/api/series` 整前缀切过去"这个动作会引爆它，
  而那时的表现是最难查的一种：书房管理器拿到 200 空列表，一声不吭。修法是把两件事拆成两条 URL。
  教训是**双轨期的接口清单要按"URL × 方法 × 语义"三元组核，按"URL 存在不存在"核会漏**。
  顺带一条同族的口径坑：Java 侧原来用带类型的 `@RequestParam int limit`，`?limit=abc` 就是 400
  加一段带时间戳的默认错误体，而 Node 是 `Number("abc") || 60` → 200 正常数据；现在两侧共用
  `NodeShapes.jsNumber()`（JS 的 `Number(字符串)`：认 `0x10` 不认 `1d`）把这类取值收成一份实现。
- **一份建表脚本里写着 `USE`，程序化应用它就会走进生产库**：`db/schema.sql` 开头两行是
  `CREATE DATABASE IF NOT EXISTS inkstack; USE inkstack;`——对 mysql 客户端这是贴心，对
  `multipleStatements` 的连接池这是一次劫持：你指定了临时库，语句却跑在 `USE` 之后的那个库里。
  本仓库为此修完 `SchemaBootstrap` 之后仍看到"临时库里有表"，一查是参照库自己也被写花了。
  建库器因此**只执行 CREATE / ALTER 语句**，而闸门 16 额外钉两条：参照库应用脚本前先剥 `USE`，
  并且每一步都断言 `SELECT DATABASE()` 还在预期库里。教训：**凡是会被程序喂的 SQL 文件，
  要么不含会话级语句，要么执行者必须显式过滤**——"人手工跑没问题"不是证据。
- **删掉一处懒建表，要先确认它是唯一一处**：`SendCodeController` 上挂着一个 `@PostConstruct`
  直接调 `EmailCodeMapper.ensureTable()`，那是建表脚本之外的第二条 DDL 路径。它让闸门 16 的
  "`auto=false` 时一张表都不建"整条红掉（表数 = 1），顺带暴露了更糟的一半：**数据库不可达时它
  抛异常、进程直接起不来**，而 `SchemaBootstrap` 是按语句容错的。现在建库只有 `SchemaBootstrap`
  一个执行者。规则：**灰度一个"唯一入口"之前，先拿开关反证它真的唯一**——正例（开着能建）
  绿了不算数，反例（关着不能建）才是排他性证明。

双轨期的一个已知缺口（不是 bug，是还没并到一起的状态）：**登录 / 改密的失败计数是各进程自己记的**
——Node 的 `lib/rate-limit.ts` 用一个 `Map`，Java 的 `LoginGuard` 另用一个 `Map`，同一账号在
两栈各试 5 次不会锁住。单栈部署没这个问题，双轨窗口内靠"切流按前缀、同一时刻只有一栈在应答"兜着。
P7 把它连同边缘限流一起搬到共享存储（Redis 或库表）。

另一个已知缺口在流式超时：Node 的透传通道用 `AbortSignal.timeout(60_000)`，信号能在一次 read
正卡着时把它打断；Java 的 `InputStream` 只能在两块数据之间判 deadline，遇到"60 秒一个字节都不来"
的挂起要靠连接层（反代 / TCP）先收走。窗口内这条上游只可能是本机的分身服务，所以先记账不改造
——真要治得换非阻塞 IO，与 P7 的共享限流一起动才划算。

第三个缺口是同一族但没一起改的：文章页那句「分身已回答 N 次」读的是 `articles.agent_qa_count`，
而这个计数器**只在种子与导入时写过一次**——真实问答既不填 `agent_qa.article_id`，也没有人 `+1`，
所以它永远停在种子的数字。修它得先让提问入口带上文章身份（现在 `/api/agent/ask` 的 body 只有
`question` / `author` / `about`，`about` 是标题不是 id），要动前端与请求契约，双轨期两栈还得一起改，
所以单独记一条，不像 `asker_id` 那样顺手就能补。

页面侧（Server Component 进程内取数，不经 HTTP）：`lib/data.ts` 的**只读内容面已全部可分流**
——列表 / 详情 / 评论 / 打赏 / 收藏 / 专栏导航 / 关注关系 / 我的专栏 / 搜索 / 话题页 /
作者主页 / 专栏架 / 专栏落地页 / 周报计数 / 漫游记 / 个人中心六类足迹 / 创作台四组看板，
由 `DATA_VIA_JAVA` 逐函数控制，默认关闭。
`listHot` / `listRelated` / RSS / sitemap 不单独分流：它们是 `listArticles` 下游的纯 JS 组装，
上游一切就跟着切，在 Java 里重算只会多出两套排序口径。

## 🏗 架构

```
浏览器
  │  同域、同一枚 ink_session Cookie
  ▼
Next.js 15 (App Router)  :3100
  ├─ 页面（Server Component）…… 目前仍进程内直调 lib/data.ts → MySQL
  ├─ /api/*  ── 未切流 ──────────→ Node Route Handler → MySQL
  └─ /api/*  ── JAVA_ROUTES 命中 ─rewrite─▶ Spring Boot :3101 → MySQL（同一库）
                                                ├─ MyBatis-Plus 手写 SQL
                                                └─ 智能体引擎（Spring AI + 文章检索工具）→ OpenAI 兼容端点
（原 agent-service/ (Python FastAPI + AgentScope) :8100 已在 P6c 移除，引擎收进 Java 进程内）
```

安全闸口（限流、CSRF、安全响应头）留在 Next 边缘中间件里，**与"谁来处理请求"解耦**——
所以切流不会削弱任何一道防线。浏览器不直连 Java：会话 Cookie 是 host-only，而 CSRF 校验比对的是
带端口的 Origin，因此所有到 Java 的请求都由 Next 服务端转发。
转发这条路上有一处会静默出错：`NextResponse.rewrite` 会把请求的 **Host 覆写成后端地址**，
所以任何"由请求自己算绝对链接"的逻辑（导出 Markdown 里的 `url:` 与原文链接）都会得到
`http://localhost:3101/...` 这种用户不该看到的内网地址。middleware 因此在转发前显式
`set` 了 `x-forwarded-host` / `x-forwarded-proto`（用 set 而非 append，客户端伪造的同名头到不了 Java），
Java 侧按「站点配置 → x-forwarded-host → Host」三级取值，闸门 11 反向断言 `:3101` 绝不出现在导出里。

## ✨ 功能与归属

**阅读与创作**：杂志信息流首页（重力排序：互动热度 × 时间衰减，置顶 > 加热中 > 自然重力）、
文章页（Markdown 渲染 / 代码复制 / 阅读进度 / 目录高亮 / 上下篇）、AI 创作台（续写·润色·起标题·荐题）、
专栏合集与打包价、每周墨报、搜索 / 热榜 / 归档 / 标签墙 / 随机漫游。

**AI 分身**：每位博主一个 ReAct 分身，读者可与「文章本人」对话；NDJSON 流式输出；
RAG 用 MySQL ngram 全文索引检索博主文章，回答带依据引用。

**墨水经济**：充值 / 打赏 90·10 / 付费解锁 70·30 / 专栏打包 / 限时折扣 / 加热 boost /
转化漏斗看板。所有资金操作**单事务原子**：占位判重 → `FOR UPDATE` 扣款 → 同事务分账流水。

**社区与安全**：邮箱验证码注册登录、评论点赞、举报流转、审核工作流；scrypt 加盐口令 +
HMAC 签名 Cookie + 数据库会话表双保险、TOTP 两步验证（手写 RFC 6238）与一次性备份码、
全站 API 限流、CSP/COOP/CORP/HSTS、HIBP 泄露密码检查、新设备登录提醒、审计时间线。

> 完整功能说明见原版仓库；本仓库的增量在于换栈机制本身，见下两节。

## 🧪 质量闸门（本仓库的核心方法）

换栈最大的风险是"看起来一样，其实不一样"。所以每个模块都必须过十六道机器闸门：

```bash
# 1) 对拍：同一请求打两栈，递归比键集 / 类型 / 数组顺序。
#    只打两栈都存在的 HTTP 路由；为 Java 新增的聚合端点（/api/users/{id}/relation、
#    /api/articles/{slug}/tips|saved|series-nav、/api/series/mine）Node 侧没有对位路由，
#    它们的形状契约由闸门 4 在渲染层验，用 1 打会得到 node=404 的假失败。
node scripts/parity.mjs /api/articles /api/articles/pgvector-gou-yong
node scripts/parity.mjs --login /api/auth/me          # 带登录态
node scripts/parity.mjs "/api/search?q=then" /api/checkin /api/topup/orders
#   目标必须挑"两栈都挂了同方法"的 URL：打一个 Node 没有 GET 的路径（如 /api/series/{id}）
#   会得到 node=405 java=200 的假失败——那是切流缺口，该由闸门 8 报，不该由对拍报。

# 2) 会话互通：两侧各自登录，要求对方后端用自己的完整校验链认下这枚 Cookie
node scripts/interop-check.mjs
#   PASS  Node→Java：Java 认下对方签发的会话
#   PASS  Node→Java：登出后 Java 立即失效（sessions 吊销跨栈生效）
#   …… 合计 8 项，失败 0 项

# 3) 正确性专项：对拍只能证明"一致"，证明不了"都对"
node scripts/paywall-probe.mjs bo-20260911-1
#   按 匿名 / 运营 / 已购读者 / 登录但未购非作者 四种身份取样，
#   覆盖 viewerUnlocked 的全部三个 SQL 分支，断言未解锁者正文行数 ≤ 6
node scripts/search-leak-probe.mjs bo-20260911-1
#   检索侧的纵深：拿**只出现在第 7 行之后**的词去搜，未解锁身份必须 0 命中
#   （否则隐藏正文就是一个可无限探测的 oracle），有权身份必须命中且摘录 ≤120 字。
#   若所有身份都不命中，探针自己判负——四条"不命中"可能只是空话。

# 4) 页面级双轨：接口对拍管不到 Server Component 的进程内取数，
#    所以再起一个 dev 实例（须独立 distDir，否则两者互冲 manifest），
#    比较两种取数下读者真正看到的可见文本 / 链接序列 / 结构计数。
#    两条铁律：
#    · 两侧都 500 会被显式判负——共同失败不是"一致"。
#    · **必须带 --login 逐个身份跑**。游客态下"Cookie 转发出错"和"Java 正常应答"
#      渲染结果完全相同，闸门会替 bug 背书：本项目真实踩过一次把
#      cookies().get().value（只有值）当 Cookie 头发给 Java，Java 认不出会话就把
#      作者本人和已购买者一律降级成游客付费墙，24 个页面里只有带身份的 18 个能看出来。
NEXT_DIST_DIR=.next-java DATA_VIA_JAVA='*' \
  node node_modules/next/dist/bin/next dev -p 3300 &
PAGES="/ /article/bo-20260911-1 /article/nei-rong-chuang-zuo-ai-shi-yong-shou-ce /author/9 /me /study"
node scripts/page-parity.mjs $PAGES                    # 游客
for ID in test writer probe; do node scripts/page-parity.mjs --login=$ID $PAGES; done

# 5) 跨栈认证流程：验证码与会话必须"一侧签发、另一侧消费"才算互通。
#    同栈自测永远发现不了哈希口径或时效写岔——只有交叉使用会暴露。
node scripts/auth-flow-check.mjs
#   Node 签发→Java 注册 / Java 签发→Node 注册 / 一码两吃被拒 / 假码停在验码分支 /
#   Node 生成密钥→Java 校验开启→两栈都要二因子→备份码一次一毁→Node 关闭 /
#   改密保留当前会话并下线其他设备（跨栈可见）…… 25 项
#   ⚠ 本仓库 .env 里 SMTP 是**真实配置**，直连跑会真发信（注册成功即发欢迎邮件）。
#     必须另起一对"邮件降级"临时实例，跑完即停：
MSYS_NO_PATHCONV=1 SMTP_HOST="" NEXT_DIST_DIR=.next-mailtest \
  JAVA_BASE=http://localhost:3199 JAVA_ROUTES=/api/auth \
  node node_modules/next/dist/bin/next dev -p 3299 &
SERVER_PORT=3199 INKSTACK_MAIL_HOST="" mvn -f server/pom.xml spring-boot:run &
PARITY_NODE=http://localhost:3299 PARITY_JAVA=http://localhost:3199 \
  node scripts/auth-flow-check.mjs
#   两个坑：① MSYS 会把 "/api/auth" 改写成 "D:/Git/api/auth"，切流前缀必须带
#     MSYS_NO_PATHCONV=1；② 临时实例会改写 next-env.d.ts / tsconfig.json 指向
#     .next-mailtest，提交前记得 revert 这两个文件。

# 6) 切流代理路径：浏览器只见 Next 地址，认证请求靠 middleware rewrite 转发。
#    会在这条路上丢东西的三样是 Set-Cookie、请求体、边缘安全闸口——直连两栈都测不出来。
node scripts/proxy-cutover-check.mjs --base=http://localhost:3299
#   X-Backend: inkstack-java 由 Java 过滤器打上，是"这条请求确实落在 Java"的唯一硬证据；
#   同时反向断言 /api/articles 与 /api/articlesXYZ 仍由 Node 应答（切流不能过宽），
#   并断言跨站 Origin 的写请求在边缘就 403（安全闸口不随切流下沉）。

# 7) 资金闸门：对拍只能比"读到的东西"，钱要的三件它表达不了——
#    ① 同一笔写一侧执行、另一侧看得懂（已购/已打包/已签/已付 的幂等分支跨栈一致）；
#    ② 六路并发双击两栈不打折：账务只动一次，败者拿到"已成交/余额不足"，绝不是一路 500；
#    ③ 增量精确：Δ余额 = ΔΣ流水 + 脚本手工注入的量，且 reason / 金额 / 明细行等于分账公式的结果。
node scripts/money-check.mjs
#   解锁 70·30、打赏 90·10、打包按 floor(price/n) 比例分账且余数归首条、加热 80/24h、
#   签到 7 天周期 10/10/20/10/20/10/40、集章 100、充值四档——七个环节 + 账实核对共 100 项。
#   ⚠ 会真扣真加真删：必须确认 DATABASE_URL 指向克隆库，跑完 finally 自动清场（并自检没留东西）。
#   --keep 保留现场排查。
#   这一道闸门抓到的真 bug：六路并发签到 Java 返回 500——同主键并发插入 InnoDB 未必给
#   DuplicateKey，也可能给死锁回滚，Spring 翻译出的就不是 DataIntegrityViolationException。
#   Node 侧同样有这个洞（dev 模式编译串行化掩盖了它），两侧一并补了"锁冲突重试三次"。

# 8) 路由清单：切流是**前缀级**的，而两栈在同一 URL 上的方法集合并不天然相同——
#    Node 的 GET /api/series 是"我的专栏"（要登录），Java 的是公开合集架。
#    切了就把书房管理器打成 200 空列表，且不会有任何报错，对拍也测不出（只比两边都有的路由）。
node scripts/route-inventory.mjs          # 列缺口 + 算出当前可整体切流的最长前缀
node scripts/route-inventory.mjs --json   # 机器可读
#   退出码恒 0：这是进度条不是判分。改完任一侧路由都要重跑一次再决定切流范围。
#   比对前会把 Java 的 `{provider}` 这类通配段与 Node 的字面目录（app/api/auth/github）对上，
#   否则已迁完的 OAuth 会被报成三条缺口——清单一旦开始说谎，就没人在切流前查它了。

# 9) 社区互动闸门：评论/点赞/收藏/关注/举报/站内信这六条链路，各有对拍表达不了的洞——
#    奖励日上限"拒了不能吞额度"、举报防重靠的是锁而不是唯一键、并发 toggle 后计数要与关系行守恒。
node scripts/community-check.mjs
#   九节 108 项：跨栈看得懂（一侧发的评论另一侧读得到、一侧标的已读另一侧未读数跟着降）、
#   六路并发两栈零 500 且关系行至多一行、like_count = COUNT(article_likes)、
#   游客也能发的评论其昵称裁剪与全角空格判空两侧同口径。
#   ⚠ 一次约 150 个请求，贴着边缘限流（每 IP 120 次/分）的上沿：连跑要隔一分钟，否则红一片 429。

# 10) 创作台闸门：发布/编辑/撤回这条链路的三个洞，读侧对拍一个都盖不住。
node scripts/studio-check.mjs
#   · 中文标题一律回退成 bo-日期-1 这种**可枚举且必撞**的 slug，8 路并发同名发布必须换号重试；
#     原实现"SELECT 判重 → 裸 INSERT"是 7×500，用户以为没发出去、重试即重复稿。
#   · 审核归属（普通用户 pending / 运营 approved）只能来自 Cookie 里的 role；
#     闸门会往请求体里塞 reviewStatus/role 验证它无效。
#   · 草稿是硬删：八张子表按 article_id 在同一个事务里清完才删主行，
#     分条自动提交就会留下"稿子还在、点赞却被清空"的部分删除。
#   · 早鸟折扣的入参时间走 JS `new Date(串)` 的口径解析（无时区的日期时间 = 本地时区），
#     两侧对同一个 datetime-local 串必须算出同一个 UTC 瞬间，否则早鸟到点差一个时区。

# 11) 运营台闸门：这一批的洞不在"算得对不对"，而在权限与状态机。
node scripts/admin-check.mjs
#   · 门禁逐条接口都要 401/403 两栈齐全：少一个，运营台就成了任何人都能调的写接口；
#     `setRole` 更是 developer 专属——前端隐藏下拉不是防线，admin 打过去也必须 403。
#   · 状态机要能回退且不留僵尸态：pin 是 toggle（跨栈同一套 1-pinned 语义）、
#     下架必须连带 pinned=0/featured=0、通过审核要把旧的驳回说明清成 NULL。
#   · 扣回点墨按**真实余额变化**记 `applied`：原写法 `GREATEST(0, …)` 会留下
#     "账记 -10000、余额只掉 60"，`point_ledger` 求和与余额从此永久对不上。
#   · `{slug}/raw` 认作者与运营、`{slug}/export` 认付费墙（未解锁 402）：这两个是全文出口，
#     少判一句就是可以无限拉全文的洞。夹具正文刻意排到第 9 行——读侧在 SQL 层只留前 6 行，
#     "导出的是全文"这句话只有这样才能被断言。
#   · 导出内嵌绝对链接：两侧各用自己的 origin 拼接，比对前必须抹掉站点地址；
#     经代理那一条反过来断言 `:3101` 绝不出现（见闸门 6 的 x-forwarded-host）。

# 12) 书房闸门：这批的洞在"门禁姿势不齐"和"字符串口径"，不在算术。
node scripts/study-check.mjs
#   · 三条反直觉的姿势必须原样照搬，"顺手统一"就是一次静默的接口变更：
#     友链 GET/PUT 对游客回 **403**（不是 401）、足迹上报对游客回 **200 skipped**、
#     外链审核不存在的 id 照样回 ok（Node 不判 affectedRows）。
#   · 标题裁 200 但**不 trim** 去查、正文**不 trim** 去存、昵称却必须按 JS 的空白判据折叠：
#     "张　　三"要折成"张 三"，Java 的 `\s` 与 `trim()` 都不认全角空格，一处用错两栈就分叉。
#   · 上传两栈必须写**同一个磁盘目录**：Java 的 cwd 是 server/，配错的表现是
#     "上传成功、URL 回来了、图片 404"，而两侧各测各自的都发现不了。
#   · 重设专栏篇目是整单语义：混进一篇别人的稿就整单拒、且原柜子一篇不少
#     （DELETE 必须排在校验之后、同一个事务里，先删后插就是"双击保存把柜子清空"）。
#   · 坏 JSON 与空对象是**两个不同的 400**（"请求格式有误" vs 业务提示），
#     用 `Bodies.json()` 一把兜成空对象就把其中一条分支抹掉了。
#   · §7.5 钉的是"一条 URL 只干一件事"：`GET /api/series` 是公开架（匿名 200、不带 `ok` 键）、
#     `GET /api/series/mine` 是我的柜子（匿名 401 而不是空列表）。这两句合起来才是那次拆分的
#     验收——只测"两边返回一样"会放过最坏的那种错法：把两条都改成同一个意思。
#     参数与 id 的取值形态也逐条比字节（`limit=0`/`abc`/`9999`、`author=0x2`/`2.5`/`-1`、
#     `id=abc`/`2.5`），因为这类解析在 Java 侧一旦图省事用带类型的 `@RequestParam int`，
#     对岸就是 400 加一段带时间戳的默认错误体——两台机器都没 bug，只是不再相同。
#   · ⚠ 会改联调账号的昵称与口令：清场按快照直接写回 `password_hash`，
#     不走接口——那个密码在 HIBP 泄露名单里，接口拒它是对的，但不是清场该有的姿势。
#   · ⚠ 同样吃边缘限流（每 IP 120 次/分）：连跑要隔一分钟，否则后半程红一片 429。

# 13) 迁移工具闸门：全平台唯一一处"用户给地址、服务端替他联网"，防护本身就是被测对象。
node scripts/import-check.mjs
#   · 私网有十几种写法而它们必须是同一个结论：`new URL()` 会把 2130706433 / 0x7f000001 /
#     0177.0.0.1 / 127.1 / `127。1`（全角句号）全部规范成 127.0.0.1。用 JDK 自带的
#     `java.net.URI`/`URL` 一种都不认——它们会把这些串当"域名"丢进 DNS，而操作系统照样按
#     IPv4 连出去，黑名单整条失效。Java 侧因此自带了一个 WHATWG 口径的解析器（NodeUrl）。
#   · 编写这一道闸门时抓到的真实绕过：`[::ffff:192.168.1.2]` 被 WHATWG 压缩成
#     `[::ffff:c0a8:102]`，于是 Node 原实现"取 `::ffff:` 之后按 IPv4 正则判"拿到的是十六进制串、
#     不命中就放行，实测 200 打到了本机网卡。两侧现在都先解析成**字节**再判（闸门 13 / 2 节）。
#   · 重定向必须手动逐跳：夹具用一个公网首跳 302 到 127.0.0.1，第二跳要拿到同一句拒绝——
#     这一条需要外网，跑不到时记 SKIP 而不是 PASS（离线是唯一让它闭嘴的合法理由）。
#   · 产物比的是**库里每一列**，而且是"两栈各清一遍各导一轮"：两个栈往同一张表写，
#     同一轮里读两次只是把同一行读了两遍，连"Java 把正文写坏了"都报不出来。
#     消毒那七条正则的期望结果是**手推**出来的常量，否则两栈一起错就一起绿。
#   · 日期是 RFC 1123 的天下：`Wed, 23 Sep 26`（两位年）、星期名写错、缺时区、`+0800`，
#     V8 全认；再加上 mysql2 按驱动本地时区绑定 Date、目标列 DATETIME(0) 会把 .700 进位成下一秒。
#     四件事凑一起，"两侧读回同一个瞬间"必须逐条钉，否则早鸟到点那种口径错会原样复现。
#   · ⚠ 需要一对 `IMPORT_ALLOW_PRIVATE=1` 的临时实例（夹具订阅源必然在 127.0.0.1 上）：
#     常规那一对照旧拒绝所有本机地址，抓取成功类用例一条都跑不到。会真建真删文章，跑完自动清场。

# 14) AI 面闸门：这一道测的不是"文字好不好"，而是**钱只在真实产出那一刻动一次**。
node scripts/ai-check.mjs
#   · 计费口径是"只读探针预检 → 上游确认可用之后才扣"。原实现是"先扣后生成、失败再退分"，
#     退分一失败就永久丢墨，模板兜底也照扣（文案还谎报"已退回"）。所以顺序本身是断言：
#     探针拦住 → 上游必须收到 **0** 次请求（否则用户白等、平台白烧 token）；
#     上游空白/500/非 JSON → 落模板、Δ余额=0、Δ流水=0，三种坏态 × 两栈逐个钉。
#   · 四段演示模板是 Node 的字符串常量，Java 重抄一遍：前导 `\n` 少一个肉眼看不出来，
#     而这段文字直接给读者看，所以按逐字节比。Java 侧刻意不用 text block——它会做缩进剥离，
#     正好会把"少一个换行"这件事藏起来。
#   · 六路并发只给两次成功：探针**不是**防线（六路同时通过预检），FOR UPDATE 才是。
#     余额 40 → 10，四路 402、零路 500。
#   · 类型收口看的是**上游收到的字符串**：`{draft: 5}`、`{author: ["甲","乙"]}` 这类 body 合法存在，
#     两栈必须各自 `String()` 成 "5" / "甲,乙" 再转发（数组按 join(",")、对象成 [object Object]）。
#     这些用例一律挂在 garbage 档上跑：断言的是请求体，不该真扣墨，也就不会打扰收尾的账实核对。
#   · 收尾一律按快照复原，且闸门自己垫本：上一批被杀在"把余额强设成 3"那一步之后，
#     账号就永久停在 3、下一批直接跑不动（真踩过）。垫的钱不落流水，否则账实核对那条
#     "本次没有别的 reason 偷偷记账"会被自己的垫本打红。
#   · 分身问答（NDJSON）三条通道各有各的"钱停在哪"：透传档要等上游 2xx 才扣、live 档要等
#     DeepSeek 给出 200 响应头才扣、演示档从头到尾不动账。所以上游坏在哪个时刻，断言就下在哪个时刻：
#     503 → 一条 error 帧 + 零扣墨；吐两帧再把连接掐了 → 那两帧照给读者、末尾一条 error 明说
#     "本次已按成功计费"、且**没有** cite 帧。中途炸掉那种"钱扣了货没给全"是诚实交易，
#     装作没发生才是问题。
#   · SSE → NDJSON 的转换器用 7 字节一块的夹具喂：一定会切在多字节字符中间、也会切在行中间。
#     Node 是"增量解码后按行切"，Java 是"按字节找换行、整行解码"（\n 不可能出现在 UTF-8
#     多字节序列里，所以两种写法必须给出同一个产物），夹具里还混了注释行、非 JSON 行、
#     空 delta 和 [DONE]——一帧都不许漏给读者。
#   · 三条通道的模式判据来自两个开关，所以这一道要**两对**临时实例：一对接夹具（假 Key +
#     `DEEPSEEK_BASE_URL` 指到夹具自己的 `/chat/completions`），一对什么都没配（演示档，游客可问）。
#     ⚠ 假 Key 与夹具 base 必须成对出现：只配 Key 不配 base，"上游 503 不许扣墨"这条用例
#     每跑一次就真向官方 API 发一次真请求、真扣一次墨。
#   · 问答会往 `agent_qa` 落流水（三条通道各落各的形状），清场按 id 区间一起删——它进统计与成就。
#   · ⚠ 需要一对接了上游夹具的实例（`AGENT_SERVICE_URL` 指向闸门自己的 127.0.0.1:4601），
#     否则"上游真产出 → 真扣墨"这一档跑不到，而那正是唯一会动钱的地方。
#   · ⚠ 绝不允许拿真大模型跑这道闸门：本机的 `DEEPSEEK_API_KEY` 在 shell 环境里而不是 `.env`，
#     闸门用的两栈实例都不带它，模式判据因此写成"两栈一致 + 上游不在场就绝不报 agentscope"，
#     而不是硬编码 `demo`——硬编码在有 Key 的机器上会假红。

# 15) 引擎闸门：Java 侧 Spring AI 智能体顶掉 Python 的 agent-service。这一道**没有对岸可比**
#     （引擎只存在于 Java 侧），所以全部换成绝对判据。
node scripts/agent-engine-check.mjs
#   · 先证明"检索真的跑了"：模型第一轮拿到分身 system prompt 与工具清单，第二轮才带着
#     role=tool 的消息继续。少一轮就说明 ReAct 被写成了单次直连——那才是换引擎最容易偷偷降级处。
#   · 再证明语料带两道闸门。判据必须成对：先用 Python 原版那条**缺防护**的 SQL 查出
#     "未解锁的付费正文"和"未过审稿"本来会进检索集，再证明引擎发给模型的那份里没有它们。
#     只写后半句是空断言——检索集里本来就没有它，任何时候都绿。
#     （哨兵刻意用稀有中文串：用 FREE-SENTINEL 这类写法时 ngram 二元组会命中库里现成文章，
#     三篇夹具稿被挤下 LIMIT 3，前面那句"本来会进检索集"就查不出来了。）
#   · 契约与手感：delta 拼回去必须等于模型的整段回答、末尾恰好一条 cite、cite 是从
#     「依据：《…》」那行抽出来的、切块宽度仍是 Python 的 max(1, len // 40)。
#   · 钱：探针拦住 → 模型收到 0 次请求；引擎 502 或只回空白 → 落演示档、Δ余额=0；
#     成功一轮才有一条「分身问答」流水。写作档同理（坏态落模板、零扣墨）。
#   · ⚠ 需要一台只开引擎的 Java 实例（`--inkstack.agent.engine=spring-ai`，同时把 service-url
#     与 deepseek-key 留空）：那样"引擎失败之后落到哪一档"才是确定的演示档，不会去敲某台真服务。
#     夹具是一个本地 OpenAI 兼容端点（默认 4702），假 Key 配假地址，永远碰不到官方 API。
#   · ⚠ 会真建三篇文章、真扣墨、真写 agent_qa，跑完按快照与 slug 全清；全文索引刚写完可能查不到，
#     闸门遇到这种情况直接停下提示重跑，而不是把检索类用例静默跳成绿。

# 16) 建库闸门：Java 进程自己把库建出来，且建出来的形状 == Node 那套 DDL 全跑完的形状。
#     双轨期建库是 Node 的 ensure* 顺手做的；P7 删掉那些 SQL 之后「谁来建库」只剩一个答案，
#     所以现在就得有人证明这个答案够用——而不是等删完才发现少一张表。
node scripts/schema-check.mjs
#   · 五个环节，每一环都是拿**真库**比的，不是拿代码比的：
#     ① 对着一个空的临时库 `spring-boot:run`，起来之后 `GET /api/articles` 必须是 200
#       （表不存在时这里是 500，所以这一条同时钉住了「200 是建库建的」）；
#     ② 逐表、逐列、逐索引、逐外键与「手工应用 db/schema.sql」的参照库对 information_schema，
#       再确认覆盖运行库 inkstack_j 的每一张表——少一张就是 P7 删完才炸出来的洞。
#       比的对象是 information_schema 里的类型、可空性、默认值，不是「看着差不多」：
#       DEFAULT 0 与 DEFAULT '' 差一个，「这行算不算已扣墨」就可能两栈不同。
#     ③ 新库里 0 用户 0 文章：schema.sql 末尾那两条演示 INSERT 归 scripts/seed.mjs，
#       不归每次启动。建库只执行 CREATE TABLE / ALTER TABLE，别的语句一律丢掉。
#     ④ 同一个库再起一次：仍然 200，且表/列/索引一个没变（幂等，不是先删再建）。
#     ⑤ `INKSTACK_SCHEMA_AUTO=false` 对着空库起进程：一张表都不建，且接口确实应不上——
#       这一条是反证，缺了它上面那个 200 就可能是别的什么顺手建的。
#   · ⚠ 这道闸门自己会 `CREATE DATABASE`（三个临时库），所以要拿有建库权限的连接跑，
#     并且**必须**在 finally 里把临时库 DROP 掉。⚠ 程序化应用 `db/schema.sql` 前必须先剥掉
#     开头的 `CREATE DATABASE …` 与 `USE …`，否则会话被带走、脚本往生产库里建表
#     （这一条是被一次真实事故换来的，见「迁移进度」一节末尾那两条教训）。
#   · ⚠ 参照库只读。闸门全程不许对 inkstack / inkstack_j 写任何东西。
```

切流与回滚：

```bash
# .env
JAVA_BASE=http://localhost:3101
JAVA_ROUTES=/api/articles            # 逗号分隔前缀；* 为全切；留空即整套回滚
```

前缀太粗时可用**段通配**逐条切：条目里的 `*` 只匹配一个路径段，其余字符按字面转义，
命中判断仍是 `^前缀(?:/|$)`。所以 `/api/articles/*/unlock` 只把解锁这一个动作交给 Java，
同前缀下尚未迁完的分支继续留在 Node——P4 的资金端点就是这样切走的。
P5c 之后 `/api/articles` 与 `/api/admin` 两个前缀已经**整前缀安全**（闸门 8 现算），
下面的实例仍写成段通配是有意的：这样 `--keep=/api/articles` 那条"没在名单里的前缀不得被带走"
的负断言才有落点。真要整体切，把这两条换成 `/api/articles,/api/admin` 并把 `--keep` 指到一个还没迁的前缀。

闸门 6/7/11 用的那个"已切流"实例就是这么起的（第二个 dev 实例必须给独立 distDir）：

```bash
MSYS_NO_PATHCONV=1 NEXT_DIST_DIR=.next-cutover \
JAVA_ROUTES=/api/auth,/api/security,/api/checkin,/api/me/badge-claim,/api/topup,/api/notifications,\
/api/admin,/api/users/*/follow,/api/comments/*/like,/api/comments/*/report,\
/api/articles/*/unlock,/api/articles/*/tip,/api/articles/*/boost,/api/articles/*/comments,\
/api/articles/*/like,/api/articles/*/bookmark,/api/articles/*/report,/api/articles/*/paywall-view,\
/api/articles/*/raw,/api/articles/*/export,/api/series,\
/api/drafts,/api/history,/api/links,/api/uploads,/api/me/profile,/api/me/password,/api/import,/api/ai,/api/agent \
  node node_modules/next/dist/bin/next dev -p 3400
node scripts/proxy-cutover-check.mjs --money --community --admin --study --import --base=http://localhost:3400
node scripts/admin-check.mjs          # 其中的"经代理导出可比对"一节会打这个实例
```

`--ai` 那一段要**换一对配置**再跑：AI 面只要落在 live/透传档，一问就扣 5 点墨、就去问真上游，
所以那个实例必须两侧都在 demo 档（闸门自己会先查 `/api/agent/status`，不是 demo 就记 SKIP 而不是发问）：

```bash
MSYS_NO_PATHCONV=1 NEXT_DIST_DIR=.next-cutover \
JAVA_BASE=http://localhost:3194 AGENT_SERVICE_URL= DEEPSEEK_API_KEY= \
JAVA_ROUTES=/api/ai,/api/agent node node_modules/next/dist/bin/next dev -p 3400
node scripts/proxy-cutover-check.mjs --ai --base=http://localhost:3400
# 3194 是闸门 14 那对"裸"Java 实例（见下一节的 ③）：同一个工程、同样的空配置，换端口而已
```

书房那六条是**整前缀**切的（`/api/drafts` 等下面没有未迁分支），`/api/series` 从 P6d 起也是整前缀：
它的 `GET` 曾经是两栈同 URL 却不同义（Node=我的专栏 / Java=公开合集架），所以只能按段通配留一条
`/api/series/*/bundle`，并在闸门 6 里反向断言"其余的必须仍在 Node"。现在两条语义各占一条 URL
（公开架留在 `GET /api/series`，"我的"挪到 `GET /api/series/mine`），那一档也翻成了正向断言：
前缀下每个 URL、每个方法都要带 `x-backend: inkstack-java`，且状态码与文案与直连对岸一致。
P6b 之后 `/api/ai` 与 `/api/agent` 两个前缀整段安全，P6d 之后闸门 8 现算出的最长可切前缀已经是
`/api` 本身（Node 侧 58 个 URL 模式、Java 全的方法集合齐、语义冲突登记表已空）——剩下的收尾
不是"还有哪些切不过去"，而是 P7 那件"把 Node 侧的取数代码删干净"。

临时实例会把 `next-env.d.ts` / `tsconfig.json` 里的构建目录指针改写成 `.next-cutover`，**提交前 revert 这两个文件**；
跑完顺手把 `.next-cutover` 和这个进程一起清掉。

## 🔒 会话互通是字节级的

两套后端共用同一枚 Cookie，任何一处偏差都会把用户劈成"半登录态"。这些约定写死在代码与单测里：

- Cookie 值 = `base64url(JSON).base64url(HMAC-SHA256)`，**签名覆盖的是那段 base64url 字符串本身**的 UTF-8 字节，不是解码后的 JSON；载荷键序固定 `sid,uid,exp`，`exp` 是毫秒
- HMAC 密钥是 `SESSION_SECRET` 的原始 UTF-8 字节，不做任何 KDF——两侧必须是同一个值
- 口令哈希 `scrypt(N=16384, r=8, p=1, keylen=64)`，存储格式 `32位hex盐:128位hex派生钥`；**喂给 scrypt 的盐是那串 hex 字符本身，不是解码后的 16 字节**（按 16 字节算会得到完全不同的哈希）
- `sessions.token_hash` 存整枚 Cookie 值的 sha256；登出 / 改密 / 封号靠这张表跨栈即时生效
- `expires_at` 由 MySQL `FROM_UNIXTIME()` 解释，两侧都不改写连接会话时区，否则同一时刻会被判成不同有效期
- `Secure` 标志跟随站点协议（http 部署带上会让浏览器拒收 Cookie，表现为"登录成功却仍是游客"）
- 付费墙：未解锁读者的正文在 **SQL 层**就被 `SUBSTRING_INDEX(md_content, '\n', 6)` 截断，全文绝不进结果集——先取全文再判权限等于没设防

## 🚀 快速开始

环境要求：Node.js **≥ 22**（20.x 必须 ≥ 20.19）、**JDK 17+**、MySQL ≥ 8。（未配数据库时前端仍能以演示模式启动。）

> Node 版本是硬要求，不是建议：渲染层经 `isomorphic-dompurify` → `html-encoding-sniffer` 以
> `require()` 加载 ESM-only 的 `@exodus/bytes`，Node 20.16 不支持 `require(esm)`，
> 文章页会直接 500（与数据源无关，两种取数下同样炸）。

```bash
# 1) 前端（与原项目完全相同）
npm install
npm run dev                 # http://localhost:3100

# 2) 数据库
mysql -u root -p < db/schema.sql
cp .env.example .env        # 填 DATABASE_URL、SESSION_SECRET

# 3) 后端
node scripts/gen-java-env.mjs        # 从 .env 派生 server/config/（含同一个 SESSION_SECRET）
cd server
mvn spring-boot:run                  # http://localhost:3101
```

两个环境坑（都踩过）：

1. **JDK 版本**：`mvn` 用的是 `JAVA_HOME` 指向的 JDK。本机默认可能是 JDK 8，
   Spring Boot 3 需要 17+，因此显式指定：`JAVA_HOME=<你的 JDK17 路径> mvn spring-boot:run`。
2. **Maven 镜像**：若你的全局 `conf/settings.xml` 里有指向内网私服的 `mirrorOf=external:*`，
   它会盖掉 `pom.xml` 里声明的仓库、连 parent POM 都拉不下来。
   本仓库用工程内 `server/settings.xml`（阿里云公共仓库）绕开，从 `server/` 目录执行 Maven 时
   由 `server/.mvn/maven.config` 自动带上 `-s settings.xml`。在 IDE 里构建需把 User settings
   file 手动指到该文件。不修改任何全局配置。

双轨联调需要两个端口同时在线，此时前端可另起端口：
`node node_modules/next/dist/bin/next dev -p 3200`，并设 `PARITY_NODE=http://localhost:3200`。

## 🗂 目录结构

```
.
├── app/                    # Next.js App Router：页面 + 尚未迁移的 Node API
├── components/ lib/        # 前端组件与设计层；lib/data.ts 是 Node 侧数据访问（P7 移除）
├── middleware.ts           # 安全头 + 限流 + CSRF + JAVA_ROUTES 切流
├── server/                 # ⭐ Spring Boot 后端（Maven 模块）
│   ├── settings.xml        #    工程内 Maven 镜像（不改全局）
│   └── src/main/java/com/inkstack/
│       ├── article/ auth/ points/ session/   # 按领域分包
│       ├── money/ community/ admin/          # 资金链路 / 社区互动 / 运营台
│       ├── series/ user/ study/              # 专栏读写 / 资料与改密 / 书房（草稿·足迹·友链·上传）
│       ├── importer/ ai/ agent/              # 迁移工具 / AI 写作与分身状态 / Spring AI 智能体引擎
│       ├── entity/ mapper/                   # MyBatis-Plus：实体与手写 SQL 映射
│       ├── common/                           # NodeShapes / Nicknames / Links / Slugs / Pricing：
│       │                                     #   Node 的取值语义与口径，逐条对齐的落点
│       └── web/                              # 参数解析器、ClientMeta、后端标记
├── db/schema.sql           # 建表脚本（含 ngram 全文索引）
├── scripts/                # 十六道闸门（parity / interop / paywall / page-parity / auth-flow /
│                           #   proxy-cutover / money-check / route-inventory / community-check /
│                           #   studio-check / admin-check / study-check / import-check / ai-check
│                           #   / agent-engine-check / schema-check）
│                           #   + 种子与运维脚本
└── docs/                   # 预览图与集成方案
```

## ⚙️ 环境变量

前端与切流相关（根目录 `.env`，全部说明见 [`.env.example`](.env.example)）：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | MySQL 连接串；Java 侧由脚本派生成 JDBC |
| `SESSION_SECRET` | **两栈必须同值**，否则会话互不认 |
| `JAVA_BASE` / `JAVA_ROUTES` | 双轨切流开关（见上） |
| `NEXT_PUBLIC_SITE_URL` | 站点地址；决定会话 Cookie 是否带 `Secure` |
| `TRUST_PROXY` | 反代后设 `1`，限流与审计才取真实 IP |
| `AGENT_SERVICE_URL` | 旧的 Python 分身服务地址（P6c 起仓库里已无该服务）。配了它，Java/Node 仍会把问答透传过去——留着是为了兼容既有部署，新部署请用下面的引擎 |
| `AGENT_ENGINE` | `off`（默认）或 `spring-ai`。`spring-ai` = 启用 Java 侧智能体引擎（Spring AI + 文章检索工具）。**只有 Java 侧有这个引擎**，开了就必须把 `/api/ai`、`/api/agent` 整前缀切给 Java |
| `AGENT_MODEL_BASE_URL` / `AGENT_MODEL_API_KEY` / `AGENT_MODEL_NAME` | 引擎接的 OpenAI 兼容端点与模型名，默认指向 DeepSeek 的 `/v1` 并复用 `DEEPSEEK_API_KEY`；换百炼只改这三行 |
| `DEEPSEEK_API_KEY` | 没有分身服务时的降档判据（有 Key → `live`，无 → `demo`）；同样派生给 Java。**跑闸门时不要把真 Key 写进 `.env`**：`/api/ai/write` 的计费链路会照着它去问真上游，烧的是账号里的墨水 |
| `DEEPSEEK_BASE_URL` | live 通道的大模型地址，默认官方。**留这个口子是给闸门指的**：`ai-check` 把它指向自己的 SSE 夹具，否则"上游 503 不许扣墨"这类用例每跑一次就真发一次请求 |
| `INKSTACK_SCHEMA_AUTO` | 默认 `true`：Java 启动时把 `db/schema.sql` 里的 `CREATE TABLE` / `ALTER TABLE` 应用到当前数据源。DB 用户没有 DDL 权限时设 `false`，改由 DBA 手工导 schema（闸门 16 §5 用反例验过它确实关得掉、且关不掉别的东西） |

后端（`server/config/application-local.properties`，由 `scripts/gen-java-env.mjs` 生成、已 gitignore）：
`INKSTACK_DB_URL` / `INKSTACK_DB_USER` / `INKSTACK_DB_PASSWORD` / `SESSION_SECRET` 等。

## 🎨 设计系统

杂志编辑风：规则线、编号排版、首字下沉、朱砂印章、竖排题字。
暖纸底 `#F6F1E7` · 近黑 `#211C14` · 朱砂强调 `#C2401A`；展示字思源宋体 + Fraunces，正文思源黑体。
令牌集中在 `app/globals.css`，CSS 按版本分层追加、不重构旧层；夜间主题统一由 `body[data-theme="night"]` 驱动。

## 📦 部署

单体版的部署手册见 [`DEPLOY.md`](DEPLOY.md)（MySQL 建库 / 环境变量 / 反代 / pm2 / 上线体检）。
Java 侧的生产部署（打包 jar、`JAVA_ROUTES` 灰度顺序、回滚预案）随 P4 一并补齐。

## 📄 License

[MIT](LICENSE) · 作者 **dujiang**
