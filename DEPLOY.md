# 墨栈 InkStack 部署指南（换栈后：Java 后端 + Next 渲染层，**两个进程**）

个人开发者版部署手册：单机 Linux 服务器 + MySQL + Nginx 反代 + pm2 守护**两个进程**。
全程预计 40–80 分钟。每一步做完打勾再走下一步。

> ⚠ 这一节是给"读到老版本手册"的人纠偏的：换栈完成之后（P7f-2），`app/api/**` 那 58 个
> Node 路由与 Node 侧那份读 SQL **已经从仓库里删掉了**，`/api/*` 恒由 Java 应答。
> 所以"只跑 Next"不再是一个可用的部署形态——页面能渲染（读的是演示数据），
> 而**每一个 `/api/*` 都是 503**（middleware 明确拒绝，不是 404：404 说"没有这个接口"，
> 真相是"这台没配后端"）。登录、发文、打赏、评论、运营台全都不通。
> 老手册里那个 `JAVA_ROUTES` 灰度开关也一起退役了：现在没有"哪一部分还在 Node"这回事，
> 只有 `JAVA_BASE` 配没配两档。**回滚是一个 `git revert`，不是一个环境变量。**

---

## 1. 服务器要求

| 项 | 最低 | 推荐 |
|---|---|---|
| 系统 | Ubuntu 22.04 / Debian 12 | 同左 |
| 配置 | 2C2G（Java + Next 两个 JVM/Node 进程 + MySQL） | 2C4G |
| 磁盘 | 20GB | 40GB（文章与上传图） |
| 软件 | **JDK 17**、Node.js ≥ 20.9、MySQL ≥ 8.0、Nginx、pm2 | 再加 Maven 3.8（只在服务器上打 jar 时才需要；CI 里打好传过来就不用） |

> AI 分身引擎在 Java 后端里（Spring AI），不额外起进程；不开第 6 节的那几个变量就是演示模式。
> JDK 用 17：本工程按 17 编译与实测（`server/pom.xml` 里 `<java.version>` 钉着），
> 21/17 之外的组合没验过，别把"能跑"当"验过"。

## 2. 域名与 HTTPS（必须先做）

平台多处依赖绝对域名：OAuth 回调、sitemap、RSS、邮件里的原文链接。
**没有 HTTPS 就不要上 OAuth 和邮件功能。**

- [ ] 域名 A 记录解析到服务器 IP
- [ ] `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d 你的域名`
- [ ] 确认 https://你的域名 打通 80→443 自动跳转

## 3. MySQL

```sql
CREATE DATABASE inkstack CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'inkstack'@'localhost' IDENTIFIED BY '生成一个强密码';
GRANT ALL PRIVILEGES ON inkstack.* TO 'inkstack'@'localhost';
FLUSH PRIVILEGES;
```

- [ ] 建库建用户（应用连接只给这个库的权限，不要用 root）
- [ ] **导一次表结构**：`mysql -u root -p < db/schema.sql`
      （文件顶部自带 `CREATE DATABASE IF NOT EXISTS inkstack; USE inkstack;`，所以它会自己把库建出来）
      ⚠ 这一步在 P7c 之后变成必须：Node 侧以前会在"第一次用到某张表"时把它懒建出来，
      现在那条路已经删掉。手工导一次是最保险的姿势；走 Java 进程的话，
      `SchemaBootstrap` 会在启动时应用同一份 `db/schema.sql`（只执行 `CREATE TABLE` /
      `ALTER TABLE`，演示数据那两条 INSERT 不在其中，要种子内容请跑 `npm run seed`）——
      但那是"帮你少敲一次命令"，不是"可以不建库"：Java 进程起不来的时候表也不会有。
- [ ] 权限收紧到只有 DML 的部署，把 `INKSTACK_SCHEMA_AUTO=false` 设进 Java 侧环境，
      否则每次启动都会因为建表被拒刷一屏告警。这个开关是闸门 16 用反例验过的：
      关掉之后对着空库启动，一张表都不建、接口确实应不上——也就是说"唯一入口"是真的唯一。
      （手工导过 `db/schema.sql` 的部署可以直接把这个开关关掉。）

## 4. 应用部署（**两个进程**：Java 后端 + Next 渲染层）

顺序很重要：**先起 Java，再构建/起 Next**。页面取数只有 Java 这一条路（P7f-1f 之后 Node 侧
没有第二条取数路径，也不会静默回落），构建期要预渲染的那几页同样要问后端。

```bash
git clone <你的仓库> /srv/inkstack && cd /srv/inkstack
cp .env.example .env && chmod 600 .env     # .env 里有数据库口令，别让同机别人读到
```

### 4.1 `.env`：两个进程共用的那一份事实来源

编辑 `.env`，逐项核对（**加粗为必填**）：

| 变量 | 说明 |
|---|---|
| **DATABASE_URL** | `mysql://inkstack:密码@localhost:3306/inkstack` |
| **NEXT_PUBLIC_SITE_URL** | `https://你的域名`（不填 sitemap/RSS/邮件链接会落 localhost） |
| **TRUST_PROXY** | **必须设 `1`**（Nginx 反代后限流/审计才能取真实 IP，否则限流可被伪造头绕过） |
| **JAVA_BASE** | `http://127.0.0.1:3101`。**非空 = 页面取数与 `/api/*` 全部由 Java 应答；留空 = 演示模式**（页面渲染 `lib/demo-data.ts` 的假数据、每个 `/api/*` 明确 503）。它不是"后端开关"而是"这台有没有后端"这一件事本身 |
| EDGE_API_LIMIT | Next 边缘那道全站 API 滑窗限流的档位，留空 = 每 IP 每 60 秒 120 次。只有一种情况需要动它：出口共用一个公网 IP 的用户群（公司 NAT / 校园网）被 120 误伤——在这里调高，别去中间件里改常量 |
| **SESSION_SECRET** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| SMTP_* | 生产强烈建议配（注册/重置/2FA 邮箱恢复依赖；漏配时生产不会回显验证码，但用户收不到信） |
| GITEE/GITHUB/QQ_CLIENT_* | OAuth 回调统一填 `https://你的域名/api/auth/<厂商>/callback` |
| AGENT_SERVICE_URL | 外部智能体服务的兼容转发地址，P6c 起仓库里已无对应实现，**自己没另起服务就留空**（空 + `AGENT_ENGINE=spring-ai` 才用内置引擎；开引擎前这里必须是空串，转发通道优先级会压住它） |
| AGENT_ENGINE / AGENT_MODEL_* | 内置智能体引擎开关与 OpenAI 兼容端点（`AGENT_MODEL_BASE_URL/API_KEY/NAME`，默认回落 `DEEPSEEK_*`） |
| AGENT_STREAM_TIMEOUT_MS | P9 起一次问答从头到尾允许多久没动静，默认 60000。同时管"上游响应头"与"上游不再吐字节"两头；没有特别理由不用动它 |
| INKSTACK_SCHEMA_AUTO | 默认 `true`：Java 启动时自动建表/加列。DB 用户没有 DDL 权限时设 `false`，改为手工导 schema（第 3 节） |

⚠ **Java 进程不读 `.env`**。二选一：跑 4.2 那条派生命令把它翻译成 Java 看的格式，或者把上面
这些键直接写进 Java 进程的环境里。别用 shell 的 `source` / `. server/config/application-local.properties`
去读那份配置——它是一份 `.properties` 而不是 shell 脚本，`SMTP_FROM=墨栈 InkStack <…@…>`
这种带空格与尖括号的值会让 shell 当场语法错（实测踩过）。

### 4.2 Java 后端（唯一应答 `/api/*` 的那个进程）

```bash
cd /srv/inkstack
node scripts/gen-java-env.mjs --prod-schema    # 从 .env 派生 server/config/application-local.properties
cd server
mvn -s settings.xml package                     # 想省时间也要先过 mvn test，别用 -DskipTests 上线
SERVER_PORT=3101 java -jar target/inkstack-server-0.1.0.jar
```

- **`--prod-schema` 不是礼貌参数**：不带它，派生出来的连接串指向克隆库 `inkstack_j`（闸门用的那个），
  于是你页面上看到的是真文章、接口写的却是另一个库。带它才用 `.env` 里 `DATABASE_URL` 那个库名。
- **工作目录要是 `server/`**：那份配置是**相对路径**导入的（`optional:file:./config/…`）。
  非要在别的目录起，就显式给定位：
  `java -jar … --spring.config.additional-location=file:/srv/inkstack/server/config/application-local.properties`
- 派生脚本会把这些一起带过去：`INKSTACK_DB_URL/_USER/_PASSWORD`、`SESSION_SECRET`、`TRUST_PROXY`、
  `NODE_ENV`、`SMTP_*`、三家 OAuth 凭证、`AGENT_*`、`INKSTACK_UPLOAD_DIR`、`INKSTACK_SCHEMA_AUTO`。
  漏一个的表现都是"最难查的那种"：邮件一侧真发一侧打印、徽标一边亮一边灭、会话一侧认另一侧不认。
- 起来之后先自己验，别等 Nginx：

  ```bash
  curl -s localhost:3101/actuator/health                                    # {"status":"UP"}
  curl -s -D - -o /dev/null 'localhost:3101/api/articles?limit=1' | grep -i x-backend
  ```

  `X-Backend: inkstack-java` 这一行是"请求真的落在 Java 上"的硬证据（本仓库的闸门也认它）。
- **3101 不要暴露到公网**：安全组/防火墙只放行 80/443，Java 只让 Next 在 127.0.0.1 上访问。
  它自己会写访问日志到 `server/logs/access_log.*`，排"这条请求到底落没落在 Java 上"时看它。
- 上传目录必须和 Next 伺服的是**同一个**目录（派生脚本写成 `<仓库>/public/uploads`）。
  配歪的表现是"上传成功、URL 也回来了、图片 404"。

### 4.3 渲染层 Next

```bash
cd /srv/inkstack
npm ci
npm run build
npm run start          # 前台试跑，即 next start -p 3100
```

交给守护之前，两件事必须**同时**成立，缺一件就是部署没完成：

```bash
curl -s localhost:3100/ | grep -c '你的文章标题里的一个词'      # 页面读的是库里的真内容
curl -s -o /dev/null -w '%{http_code}\n' localhost:3100/api/articles?limit=1   # 200
```

页面 200 而 `/api/*` 是 503，就是 `JAVA_BASE` 没进 Next 那侧的环境（不是 Java 挂了——Java 挂了
会是 502/超时，503 是这台渲染层明确说"我没配后端"）。

⚠ 关于 `npm run build` 有两件事值得知道，都是这轮实测出来的：

- **每一页都必须是动态渲染**（构建日志里那一列全是 `ƒ`，只有 `/robots.txt` 是 `○`）。
  根布局带着 Masthead，它每次渲染都要 `no-store` 取一次会话，所以任何"想在构建期被预渲染"的
  路由都会把生产构建直接炸掉——P10 第一次跑 build 就炸在 `/study`，补完又炸在 Next 自己合成的
  `/_not-found`。这一条由 `app/layout.tsx` 里的 `export const dynamic = "force-dynamic"` 兜住，
  闸门 4 的 §9 盯着它。**`next dev` 测不出来**：dev 不做预渲染，页面 200、正文齐、闸门全绿，
  只有 build 会退出。
- 构建产物写在 `.next/`，而开发实例用的就是同一个目录（`next.config.mjs` 里那个
  `NEXT_DIST_DIR` 就是为并存多实例准备的）。在一台跑着 dev 实例的机器上执行 `npm run build`，
  会把那个 dev 实例的 manifest 冲掉——表现是它下一次请求 500，重启或重新编译才好，**不是代码坏了**。
  生产机上不会同时跑 dev；开发机上要么给 dev 单独一个 `NEXT_DIST_DIR`，要么 build 完重启它。

### 4.4 守护两个进程

Java 用 systemd（上面的 `ExecStart` 就是 4.2 里手敲那条），Next 用 pm2：

```bash
sudo tee /etc/systemd/system/inkstack-api.service >/dev/null <<'EOF'
[Unit]
Description=InkStack Java backend
After=network.target mysql.service
[Service]
WorkingDirectory=/srv/inkstack/server
ExecStart=/usr/bin/java -jar target/inkstack-server-0.1.0.jar
Environment=SERVER_PORT=3101
Restart=always
RestartSec=3
User=www-data
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now inkstack-api
systemctl status inkstack-api --no-pager    # active (running) 再走下一步

cd /srv/inkstack
npm i -g pm2
pm2 start npm --name inkstack-web -- start
pm2 save && pm2 startup
```

> pm2 也能直接管 jar（`interpreter: 'java'`），但本仓库的部署姿势是在本机 `java -jar` 与
> `mvn spring-boot:run` 两条路上各自验过的，pm2 那条没跑过——不确定就别用它，systemd 这段是照
> 4.2 的命令行原样搬的。

## 5. Nginx 反向代理（关键配置）

```nginx
server {
    listen 443 ssl http2;
    server_name 你的域名;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;                 # 应用按 Host 做同源校验
        proxy_set_header X-Real-IP $remote_addr;     # TRUST_PROXY=1 时应用取真实 IP
        proxy_set_header X-Forwarded-For $remote_addr;  # 只写一次，防止伪造链
        proxy_set_header X-Forwarded-Proto $scheme;  # HSTS/绝对链接需要
        client_max_body_size 10m;                    # 迁移工坊上传 2MB 上限 + 余量
    }
}
```

- [ ] `nginx -t && systemctl reload nginx`
- [ ] **不要**原样转发客户端带来的 X-Forwarded-For（`$proxy_add_x_forwarded_for` 会把伪造链拼进来），用 `$remote_addr` 覆盖

## 6. AI 分身引擎（可选，Java 侧内置）

分身不再是独立进程：智能体引擎就在 `server/` 里（Spring AI + 文章检索工具），开不开由三个环境变量决定。

```bash
# .env（或 systemd 的 Environment=）
AGENT_ENGINE=spring-ai                 # 默认 off：不配 Key 或不开关时走演示档
AGENT_MODEL_BASE_URL=https://api.deepseek.com/v1   # OpenAI 兼容端点，换百炼只改这行
AGENT_MODEL_API_KEY=sk-...             # 不给 Key 就别开引擎（开了也只会落兜底）
AGENT_MODEL_NAME=deepseek-chat
```

然后 `node scripts/gen-java-env.mjs --prod-schema` 把这些派生给 Java 进程（Java 不读 `.env`；
`--prod-schema` 的用处见 4.2——不带它派生出来的是克隆库），重启后端即可。
`AGENT_MODEL_API_KEY` 留空会自动沿用 `DEEPSEEK_API_KEY`，两处填一份就够。

⚠ 开引擎前必须把 `AGENT_SERVICE_URL` 清空：只要它非空，Java 就先走"转发给外部智能体服务"那条
兼容通道，转发失败才落到 DeepSeek 直连——引擎永远轮不到，徽标也永远不报 `spring-ai`。
这条优先级一直如此：配了外部服务就以它为准，转发失败才落到下一档——不是 bug。

引擎关掉、且 `AGENT_SERVICE_URL` 与 `DEEPSEEK_API_KEY` 都为空时 `/api/agent/status` 报 `demo`，
开着引擎报 `spring-ai`——徽标与真实来源必须一致，这是闸门 15 的第 0 条前置。写作助手与分身问答都扣墨，**未登录一律 401**，读者侧的
提问入口已按登录态收口。

> 老的 Python 服务（`agent-service/`，FastAPI + AgentScope）已在 P6c 移除。
> 它的 SQL 缺"过审"与付费墙两道判定，会把没解锁的付费正文喂给模型复述；Java 引擎按
> `lib/rag.ts` 的口径重做，这一洞顺带补上（闸门 15 / 1 节逐条钉住）。

## 7. 上线前的一次性动作（**不是定时任务**）

### 7.1 生产构建必须真跑一次（不是 dev）

```bash
cd /srv/inkstack && npm run build     # 必须退出码 0，且构建日志里每一页都是 ƒ（Dynamic）
```

这一条写死在流程里是有来历的：本仓库的 21 道闸门全都打在 `next dev` 上，而 **dev 不做预渲染**。
P10 第一次跑 `npm run build` 直接炸在 `/study`——根布局带着 Masthead，每次渲染都要 `no-store`
取一次会话，任何"被当成可以在构建期定成静态"的路由都会让构建退出。修好之后又炸在 Next 自己
合成的 `/_not-found`，最后收在 `app/layout.tsx` 的一句 `force-dynamic`（闸门 4 §9 现在盯着它）。
**这一族缺陷没有任何运行期症状**：摘掉那一句，页面照样 200、正文照样排，只有 build 会拒绝。

### 7.2 摘要列对齐（换栈遗留的那笔旧账）

`articles` 表上有四列摘要值（`read_count` / `comment_count` / `like_count` / `agent_qa_count`），
首页、热榜排序、成就徽章、运营台漏斗都在**读**它们。新代码只保证"从这一版起增量守恒"
（P8b 才第一次有人写 `read_count`，P8a 才回填 `agent_qa_count`），**库里既存的旧账不会自己追平**。
所以上线前跑一次：

```bash
node scripts/recounters.mjs                    # 只读：报有哪几处不平（有不平退 1）
node scripts/recounters.mjs --apply            # 修"登记表外"的那些，写完复算复验
node scripts/recounters.mjs --emit-registry    # 把当前不平清单打成豁免登记表字面量
```

种子写进的那几个演示数字（12,840 之类，共 53 处）默认**不动**——首屏要好看的读数是产品决定，
不是遗留缺陷，闸门 21 按 `slug × 列` 逐条把它们登记在册。
要把它们一起抹平就加 `--include-exempt`，**但那是替产品拍板**，做完必须立刻用
`--emit-registry` 重新生成 `scripts/counter-exempts.mjs` 里那张表：只改数据不改表，
或者只改表不改数据，闸门 21 那条双向棘轮都会红。

这个工具的边界写在代码里：默认只读、只 `UPDATE` 那四列（不动行集）、库名要在连接串与
`--target` 两处同名才肯写、每一条写都是比较后再写（并发增量不会被盖掉）。
对着真库跑之前先只读量一遍，把输出留档。

### 7.3 回归闸门（挑得起码这四道）

```bash
node scripts/counter-check.mjs       # 21：四列摘要值与行集守恒（要有 Java 实例 + 克隆库）
node scripts/contract.mjs check      # 1′：接口形状对得上冻结下来的旧实现
node scripts/route-inventory.mjs     # 8：Java 应答的端点表与前端调用点对得上
node scripts/admin-check.mjs         # 11：运营台那批写路径的账实
```

闸门一律对着**克隆库** `inkstack_j` 跑（`.env` 的 `DATABASE_URL` 与 Java 的连接串都指它），
它们会真建真删、跑完按快照复原。生产库上不跑闸门。

## 8. 上线后安全自查清单（10 分钟）

- [ ] `https://你的域名/api/articles/任何付费文slug/export` 未登录返回 **402**（付费墙导出漏洞已修）
- [ ] `.env` 权限 `chmod 600 .env`，确认 `git status` 里没有 .env
- [ ] 注册一个真邮箱账号，验证码邮件能收到（SMTP 通）
- [ ] 开 2FA → 退出 → 密码登录 → 邮箱兜底恢复可用
- [ ] Gitee/GitHub 登录回调正常（多测一次新建档欢迎邮件）
- [ ] 充值页确认：生产模式**模拟支付通道已关闭**（返回"该支付通道暂未开放"），接微信支付前用户无法自行加墨——想给测试号加墨直接改数据库 `UPDATE users SET points_balance = ...`
- [ ] `curl -I https://你的域名` 检查 HSTS/CSP/X-Frame-Options 响应头在
- [ ] pm2 restart 后登录态仍有效（会话在 MySQL，重启不掉线）
- [ ] 测试跨站写请求被 403（CSRF 防线）
- [ ] **每个 `/api/*` 后面都有 Java**：`curl -s -D - -o /dev/null https://你的域名/api/articles?limit=1`
      回 200 且带 `X-Backend: inkstack-java`。回 503 + `Retry-After` 说明渲染层那侧 `JAVA_BASE` 是空的
      （这是 middleware 刻意的姿势：404 会说谎成"没有这个接口"，503 说的是"这台没配后端"）
- [ ] 分身徽标不谎报：`curl -s https://你的域名/api/agent/status`，报的那一档要与你配的环境变量一致
      （没配 Key 却报 `live`、或开了引擎却报 `spring-ai` 之外，都是派生漏了键）
- [ ] 第 7.2 那次摘要列对齐跑过，且 `node scripts/recounters.mjs` 现在退 0（登记表外全守恒）
- [ ] 定时备份：`mysqldump inkstack | gzip > /backup/inkstack-$(date +%F).sql.gz` 加 crontab

## 9. 已知边界（个人开发者版取舍）

- **失败计数在 MySQL（`rate_hits`），边缘闸在进程内存**：登录 / 改密 / 2FA / 发码的爆破计数是共享的，
  pm2 多实例、systemd 重启、Java 与 Next 两个进程都看的同一本账，窗口时钟也是 MySQL 的 `NOW(3)`；
  而 120 req/min/IP 的全站刹车**故意**留在内存——它每个请求都要过一次，进库等于给每个请求加一次写。
  所以多实例部署时爆破防护是准的，而"每 IP 每分钟 120 次"实际会变成 `120 × 实例数`，
  真要收紧那一道得换 Redis，不是换这张表
- **`rate_hits` 会长期留行**：命中时顺手扫掉本桶过期行，另有全表清扫保留 1 天（排障用）。
  要立刻解锁某个账号：`DELETE FROM rate_hits WHERE bucket LIKE 'login:某邮箱:%'`
- **上传存本地磁盘** `public/uploads/`：换机器记得迁移该目录；上对象存储是后续升级点
- **文章页那几个"阅读 12,840"是演示值，不是真读数**：种子里写进去的展示值与 53 处历史漏账
  按产品决定保留（见第 7.1），闸门 21 逐条点名豁免着。真实流量一来，`read_count` 会从那一刻
  起正常累加，但首屏那个数**仍然是假的**——要么留着当演示站，要么跑一次 `--include-exempt`
  并同步换掉豁免登记表，这是产品决定，不是运维事故
- **`AGENT_ENGINE=spring-ai` 那条通道的超时不是绝对截止**：P9 的 `UpstreamDeadline` 管的是
  透传与 live 两条流式通道；引擎走 `RestTemplate`，靠 60 秒**逐次读**超时，一个慢但一直在吐字的
  模型可以合法地跑过 60 秒。两条通道的口径不同是已知差异（闸门 14 的 stall 两档不覆盖引擎）
- **模拟支付通道**生产环境已硬关闭；接入微信支付后由回调验签触发到账
- **导出的文章中原文链接**取请求 origin，反代配好 `X-Forwarded-Proto` 即为正式域名
- 微信登录/微信支付需要企业资质，凭证就位后即插即用（回调已留好）

## 10. 出问题先看哪

| 症状 | 排查 |
|---|---|
| 502 | `pm2 logs inkstack-web`；渲染层没起或端口不对 |
| **每个 `/api/*` 都 503**（带 `Retry-After: 30`） | Next 那侧 `JAVA_BASE` 是空的——这是 middleware 刻意的拒绝，不是接口缺失。配好并重启 Next |
| 页面 500、日志是取数失败 | `JAVA_BASE` 指了但 Java 进程没起 / 端口不对：`curl -s localhost:3101/actuator/health` |
| Java 起了却读不到你库里的文章 | `gen-java-env.mjs` 漏了 `--prod-schema`，连接串指着克隆库 `inkstack_j` |
| Java 起不来，日志最后一句是 `'url' must start with "jdbc"` | 数据源那三个键没给到：工作目录不是 `server/`（配置是**相对路径**导入的），或者没把 `INKSTACK_DB_URL/_USER/_PASSWORD` 给进环境。这条是实测原话，不是猜的——占位符本身不报错，报错的是 Hikari 拿到空 url |
| 上传成功、URL 也回来了、图片 404 | `INKSTACK_UPLOAD_DIR` 与 Next 伺服的 `public/uploads` 不是同一个目录 |
| 全站 429 | TRUST_PROXY 没设 1，所有用户被并成一个限流桶 |
| 某个账号 15 分钟内一直 429 | 爆破计数在 `rate_hits`，重启进程不会清掉它（这是设计）：`DELETE FROM rate_hits WHERE bucket LIKE 'login:该邮箱:%'` |
| OAuth 回调 403/域名错 | NEXT_PUBLIC_SITE_URL 与 OAuth 应用回调地址是否都是正式 https 域名 |
| 邮件收不到 | Java 侧日志看 SMTP 报错（Node 已经不发邮件了）；QQ 邮箱用授权码不是登录密码 |
| 登录后刷新掉线 | SESSION_SECRET 改过（旧 cookie 全失效）或 sessions 表没建出来 |
| 分身回答半路停住、末尾一帧 `error` | 那是 P9 的截止在说话（默认 60 秒）。要放宽改 `AGENT_STREAM_TIMEOUT_MS`，别去猜是大模型慢还是网络抖 |
| 文章页"阅读数/问答数"与实际不符或对不上 | 先跑 `node scripts/recounters.mjs`（只读）看是哪一列差多少；种子那 53 处演示值是**登记在册的假数**，不是坏数据 |
