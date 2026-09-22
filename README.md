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
| P4 | 墨水经济（充值 / 打赏 / 解锁 / 打包 / 加热 / 签到 / 徽章） | ⏳ | 需并发对拍 |
| P5 | 社区与运营台（评论 / 举报 / 审核 / 角色） | ⏳ | — |
| P6 | AI 分身：Spring AI Alibaba 替换 Python AgentScope 服务 | ⏳ | 需保持 NDJSON 契约 |
| P7 | 收尾：web 退化为纯渲染层，删除 Node 侧 SQL | ⏳ | — |

当前由 Java 应答的接口（`JAVA_ROUTES` 留空时**全部仍由 Node 应答**，行为与原版一致）：

- 认证：`POST /api/auth/login|logout|register|send-code|reset` · `GET /api/auth/me|providers`
  · `GET /api/auth/{github,gitee,qq}` 与三家 `/{p}/callback` · `GET /api/auth/github/status`
- 安全中心：`POST /api/security/password` · `GET|DELETE /api/security/sessions`
  · `POST|PUT|DELETE /api/security/2fa`
- 内容：`GET /api/articles` · `GET /api/articles/{slug}` · `GET /api/search`
- 只读聚合（为 RSC 分流新增，Node 侧无对位路由）：`/api/articles/{slug}/comments|tips|saved|series-nav`、
  `/api/users/{id}/relation`、`/api/series*`、`/api/tags/{tag}/articles`、`/api/authors/{id}[/articles]`、
  `/api/weekly/stats`、`/api/random`、`/api/me/*` 十项

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

换栈最大的风险是"看起来一样，其实不一样"。所以每个模块都必须过六道机器闸门：

```bash
# 1) 对拍：同一请求打两栈，递归比键集 / 类型 / 数组顺序。
#    只打两栈都存在的 HTTP 路由；为 Java 新增的聚合端点（/api/users/{id}/relation、
#    /api/articles/{slug}/tips|saved|series-nav、/api/series/mine）Node 侧没有对位路由，
#    它们的形状契约由闸门 4 在渲染层验，用 1 打会得到 node=404 的假失败。
node scripts/parity.mjs /api/articles /api/articles/pgvector-gou-yong
node scripts/parity.mjs --login /api/auth/me          # 带登录态
node scripts/parity.mjs "/api/search?q=then" "/api/hot"

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
```

切流与回滚：

```bash
# .env
JAVA_BASE=http://localhost:3101
JAVA_ROUTES=/api/articles            # 逗号分隔前缀；* 为全切；留空即整套回滚
```

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
│       ├── entity/ mapper/                   # MyBatis-Plus：实体与手写 SQL 映射
│       ├── common/                           # NodeShapes：JDBC 结果 → Node 取值语义
│       └── web/                              # 参数解析器、ClientMeta、后端标记
├── agent-service/          # Python AgentScope 分身服务（P6 替换）
├── db/schema.sql           # 建表脚本（含 ngram 全文索引）
├── scripts/                # parity / interop-check / paywall-probe / 种子与运维脚本
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
