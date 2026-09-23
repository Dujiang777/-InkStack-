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
| P6 | AI 分身：Spring AI Alibaba 替换 Python AgentScope 服务 | ⏳ | 需保持 NDJSON 契约 |
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
  · `POST /api/series` · `PATCH|DELETE /api/series/{id}`（这四条**已实现却还切不过去**：
  切流只有前缀粒度，而 `/api/series` 的 `GET` 两栈同 URL 同方法却不同义——Node 是"我的专栏"
  （`components/StudioClient.tsx` 正在吃它），Java 是公开合集架。切之前的动作是先把 Node 的
  `GET /api/series` 对齐成公开架、补一条 `GET /api/series/mine`，再改前端读法，两栈同语义之后
  整前缀才敢切，见闸门 8）
- 迁移工具：`POST /api/import`（RSS 用 JSON、Markdown 用 multipart，同一个 URL 两种体）
  —— 全平台唯一一处"由用户给地址、服务端替他联网"的入口，SSRF 防护见闸门 13
- 只读聚合（为 RSC 分流新增，Node 侧无对位路由）：`/api/articles/{slug}/comments|tips|saved|series-nav`、
  `/api/users/{id}/relation`、`/api/series*`、`/api/tags/{tag}/articles`、`/api/authors/{id}[/articles]`、
  `/api/weekly/stats`、`/api/random`、`/api/me/*` 十项

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

双轨期的一个已知缺口（不是 bug，是还没并到一起的状态）：**登录 / 改密的失败计数是各进程自己记的**
——Node 的 `lib/rate-limit.ts` 用一个 `Map`，Java 的 `LoginGuard` 另用一个 `Map`，同一账号在
两栈各试 5 次不会锁住。单栈部署没这个问题，双轨窗口内靠"切流按前缀、同一时刻只有一栈在应答"兜着。
P7 把它连同边缘限流一起搬到共享存储（Redis 或库表）。

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
                                                └─ MyBatis-Plus 手写 SQL
agent-service/ (Python FastAPI + AgentScope) :8100 —— 原实现，P6 换成 Spring AI 后移除
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

换栈最大的风险是"看起来一样，其实不一样"。所以每个模块都必须过十三道机器闸门：

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
/api/articles/*/raw,/api/articles/*/export,/api/series/*/bundle,\
/api/drafts,/api/history,/api/links,/api/uploads,/api/me/profile,/api/me/password,/api/import \
  node node_modules/next/dist/bin/next dev -p 3400
node scripts/proxy-cutover-check.mjs --money --community --admin --study --import --base=http://localhost:3400
node scripts/admin-check.mjs          # 其中的"经代理导出可比对"一节会打这个实例
```

书房那六条是**整前缀**切的（`/api/drafts` 等下面没有未迁分支），而 `/api/series` 只能继续按段通配
留一条 `/api/series/*/bundle`：`--study` 里专门有一句反向断言，拿非法标题打 `POST /api/series`，
要求它**没有** `x-backend` 头（仍在 Node 应答）——语义冲突登记表若不配这条断言，就只是一段注释。

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
│       ├── entity/ mapper/                   # MyBatis-Plus：实体与手写 SQL 映射
│       ├── common/                           # NodeShapes / Nicknames / Links / Slugs / Pricing：
│       │                                     #   Node 的取值语义与口径，逐条对齐的落点
│       └── web/                              # 参数解析器、ClientMeta、后端标记
├── agent-service/          # Python AgentScope 分身服务（P6 替换）
├── db/schema.sql           # 建表脚本（含 ngram 全文索引）
├── scripts/                # 十三道闸门（parity / interop / paywall / page-parity / auth-flow /
│                           #   proxy-cutover / money-check / route-inventory / community-check /
│                           #   studio-check / admin-check / study-check / import-check）+ 种子与运维脚本
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
| `AGENT_SERVICE_URL` | Python 分身服务地址；未配置时走 Node 内置模式 |

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
