# 墨栈 InkStack 部署指南（v15.0）

个人开发者版部署手册：单机 Linux 服务器 + MySQL + Nginx 反代 + pm2 守护。
全程预计 30–60 分钟。每一步做完打勾再走下一步。

---

## 1. 服务器要求

| 项 | 最低 | 推荐 |
|---|---|---|
| 系统 | Ubuntu 22.04 / Debian 12 | 同左 |
| 配置 | 2C2G | 2C4G（含 MySQL 与 AI 分身服务） |
| 磁盘 | 20GB | 40GB（文章与上传图） |
| 软件 | Node.js ≥ 20.9、MySQL ≥ 8.0、Nginx、pm2 | — |

> AI 分身引擎在 Java 后端里（Spring AI），不额外起进程；不开第 6 节的那几个变量就是演示模式。

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
      现在那条路已经删掉，只跑本手册（pm2 只起 Next，不起 Java）的部署不会有人替你建表——
      表现不是报错，是登录、发文、打赏这些接口一个个 500。
      跑过 `scripts/gen-java-env.mjs` 并把后端切到 Java 的部署可以跳过这步：
      Java 进程启动时由 `SchemaBootstrap` 应用同一份 `db/schema.sql`（只执行 `CREATE TABLE` /
      `ALTER TABLE`，演示数据那两条 INSERT 不在其中，要种子内容请跑 `npm run seed`）。
- [ ] 权限收紧到只有 DML 的部署，把 `INKSTACK_SCHEMA_AUTO=false` 设进 Java 侧环境，
      否则每次启动都会因为建表被拒刷一屏告警。这个开关是闸门 16 用反例验过的：
      关掉之后对着空库启动，一张表都不建、接口确实应不上——也就是说"唯一入口"是真的唯一。

## 4. 应用部署

```bash
git clone <你的仓库> /srv/inkstack && cd /srv/inkstack
npm ci
cp .env.example .env
```

编辑 `.env`，逐项核对（**加粗为必填**）：

| 变量 | 说明 |
|---|---|
| **DATABASE_URL** | `mysql://inkstack:密码@localhost:3306/inkstack` |
| **NEXT_PUBLIC_SITE_URL** | `https://你的域名`（不填 sitemap/RSS/邮件链接会落 localhost） |
| **TRUST_PROXY** | **必须设 `1`**（Nginx 反代后限流/审计才能取真实 IP，否则限流可被伪造头绕过） |
| **SESSION_SECRET** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| SMTP_* | 生产强烈建议配（注册/重置/2FA 邮箱恢复依赖；漏配时生产不会回显验证码，但用户收不到信） |
| GITEE/GITHUB_CLIENT_* | OAuth 回调统一填 `https://你的域名/api/auth/<厂商>/callback` |
| AGENT_SERVICE_URL | 外部智能体服务的兼容转发地址，P6c 起仓库里已无对应实现，**自己没另起服务就留空**（空 + `AGENT_ENGINE=spring-ai` 才用内置引擎；开引擎前这里必须是空串，转发通道优先级会压住它） |
| AGENT_ENGINE / AGENT_MODEL_* | 内置智能体引擎开关与 OpenAI 兼容端点（`AGENT_MODEL_BASE_URL/API_KEY/NAME`，默认回落 `DEEPSEEK_*`）。只有 Java 侧有引擎，开了就要把 `/api/ai`、`/api/agent` 整前缀切给 Java |
| INKSTACK_SCHEMA_AUTO | 默认 `true`：Java 启动时自动建表/加列。DB 用户没有 DDL 权限时设 `false`，改为手工导 schema |

```bash
npm run build
npm run start   # 前台试跑，确认 3000/3100 端口起来后再交给 pm2
```

生产构建与安全修复全部就绪：`npm run build` + `npm start` 即可。

### pm2 守护

```bash
npm i -g pm2
pm2 start npm --name inkstack -- start
pm2 save && pm2 startup   # 开机自启
```

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

然后 `node scripts/gen-java-env.mjs` 把这些派生给 Java 进程（Java 不读 `.env`），重启后端即可。
`AGENT_MODEL_API_KEY` 留空会自动沿用 `DEEPSEEK_API_KEY`，两处填一份就够。

⚠ 开引擎前必须把 `AGENT_SERVICE_URL` 清空：只要它非空，Java 就先走"转发给外部智能体服务"那条
兼容通道，转发失败才落到 DeepSeek 直连——引擎永远轮不到，徽标也永远不报 `spring-ai`。
这条优先级是双轨期的取舍（Node 那侧没有引擎，谁配了外部服务谁说话），不是 bug。

引擎关掉时 `/api/agent/status` 报 `demo`，开着报 `spring-ai`——徽标与真实来源必须一致，
这是闸门 15 的第 0 条前置。写作助手与分身问答都扣墨，**未登录一律 401**，读者侧的
提问入口已按登录态收口。

> 老的 Python 服务（`agent-service/`，FastAPI + AgentScope）已在 P6c 移除。
> 它的 SQL 缺"过审"与付费墙两道判定，会把没解锁的付费正文喂给模型复述；Java 引擎按
> `lib/rag.ts` 的口径重做，这一洞顺带补上（闸门 15 / 1 节逐条钉住）。

## 7. 上线后安全自查清单（10 分钟）

- [ ] `https://你的域名/api/articles/任何付费文slug/export` 未登录返回 **402**（付费墙导出漏洞已修）
- [ ] `.env` 权限 `chmod 600 .env`，确认 `git status` 里没有 .env
- [ ] 注册一个真邮箱账号，验证码邮件能收到（SMTP 通）
- [ ] 开 2FA → 退出 → 密码登录 → 邮箱兜底恢复可用
- [ ] Gitee/GitHub 登录回调正常（多测一次新建档欢迎邮件）
- [ ] 充值页确认：生产模式**模拟支付通道已关闭**（返回"该支付通道暂未开放"），接微信支付前用户无法自行加墨——想给测试号加墨直接改数据库 `UPDATE users SET points_balance = ...`
- [ ] `curl -I https://你的域名` 检查 HSTS/CSP/X-Frame-Options 响应头在
- [ ] pm2 restart 后登录态仍有效（会话在 MySQL，重启不掉线）
- [ ] 测试跨站写请求被 403（CSRF 防线）
- [ ] 定时备份：`mysqldump inkstack | gzip > /backup/inkstack-$(date +%F).sql.gz` 加 crontab

## 8. 已知边界（个人开发者版取舍）

- **限流桶在单实例内存**（120 req/min/IP）：pm2 多实例或横向扩容需换 Redis，单实例无碍
- **上传存本地磁盘** `public/uploads/`：换机器记得迁移该目录；上对象存储是后续升级点
- **模拟支付通道**生产环境已硬关闭；接入微信支付后由回调验签触发到账
- **导出的文章中原文链接**取请求 origin，反代配好 `X-Forwarded-Proto` 即为正式域名
- 微信登录/微信支付需要企业资质，凭证就位后即插即用（回调已留好）

## 9. 出问题先看哪

| 症状 | 排查 |
|---|---|
| 502 | `pm2 logs inkstack`；应用没起或端口不对 |
| 全站 429 | TRUST_PROXY 没设 1，所有用户被并成一个限流桶 |
| OAuth 回调 403/域名错 | NEXT_PUBLIC_SITE_URL 与 OAuth 应用回调地址是否都是正式 https 域名 |
| 邮件收不到 | pm2 日志看 SMTP 报错；QQ 邮箱用授权码不是登录密码 |
| 登录后刷新掉线 | SESSION_SECRET 改过（旧 cookie 全失效）或 sessions 表没建出来 |
