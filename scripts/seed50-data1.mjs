// 50 篇种子文章 · 数据一（1-17，科技向为主）
export const part1 = [
  {
    author: 1, slug: "ts-router-types", cover: "型", tags: ["编程", "前端"],
    title: "TypeScript 类型体操实战：用模板字面量类型写一个安全的路由",
    summary: "字符串路径也能进类型系统：用模板字面量类型提取路由参数、校验跳转目标，把「写错路径」从运行时错误变成编译期红线。",
    md: `# 用模板字面量类型写一个安全的路由

> 字符串路径也能进类型系统——写错路径，编译器先骂你。

## § 目标

让 \`navigate("/user/42")\` 通过编译，而 \`navigate("/usr/42")\` 直接报红。

## § 核心技巧：模板字面量提取参数

\`\`\`ts
type ExtractParams<T extends string> =
  T extends \`\${infer Head}:\${infer Param}/\${infer Rest}\`
    ? { [K in Param | keyof ExtractParams<Rest>]: string }
    : T extends \`\${infer Head}:\${infer Param}\`
      ? { [K in Param]: string }
      : {};
\`\`\`

配合路由表一起用：

\`\`\`ts
const routes = {
  home: "/",
  user: "/user/:id",
  post: "/user/:id/post/:pid",
} satisfies Record<string, string>;
type ParamsOf<P> = ExtractParams<typeof routes[P]>;
\`\`\`

## § 实际收益

1. **跳转前参数必填**：函数签名强制要求 \`params\` 对象，漏传即报错
2. **重构即全量检查**：路由改名，所有引用处编译期爆红
3. **零运行时开销**：全部发生在类型层，产物里一行多余代码都没有

类型体操的正确心态：不是为了炫技，是为了**把测试用例写进编译器**。
`,
  },
  {
    author: 1, slug: "git-history-rescue", cover: "Git", tags: ["编程", "工具"],
    title: "Git 重构历史：rebase、cherry-pick 与一次优雅的背锅",
    summary: "误提交密钥、提交错分支、想把一个 commit「偷」到另一条线上——三个真实场景，三种历史手术，以及事后如何优雅认错。",
    md: `# Git 重构历史

> 历史不能修改是给外行听的，Git 的历史想怎么改都行——前提是你知道自己在干什么。

## § 场景一：误提交了密钥

\`\`\`bash
git rebase -i HEAD~5     # 把含密钥的 commit 标记为 edit
git rm --cached .env.local
echo ".env.local" >> .gitignore
git commit --amend --no-edit
git rebase --continue
git push --force-with-lease
\`\`\`

记住：**已经推到远端的密钥等于泄露**，改完历史第一件事是换密钥。

## § 场景二：提交错了分支

在 feature 上写了个 hotfix？别慌：

\`\`\`bash
git branch hotfix-branch          # 先把现场存住
git reset --hard HEAD~1           # 原分支回退
git checkout hotfix-branch && git cherry-pick <hash>
\`\`\`

## § 场景三：优雅背锅

force push 之前先 \`git branch backup-$(date +%m%d)\` 留后路；出事了直接说「我准备了备份分支，随时可回滚」。**技术救援的速度，决定背锅的姿势。**
`,
  },
  {
    author: 1, slug: "regex-in-30min", cover: "则", tags: ["编程", "学习"],
    title: "正则表达式速成：三十分钟读懂别人写的「天书」",
    summary: "不追求会写，先保证能读。一份面向代码评审场景的正则速查：分组、贪婪、断言三大件，配六个真实例子逐句拆解。",
    md: `# 三十分钟读懂正则天书

> 正则不是拿来背的，是拿来查的。今天只解决一件事：看懂。

## § 三大件

1. **分组**：\`(...)\` 捕获、\`(?:...)\` 不捕获、\`(?<name>...)\` 命名
2. **贪婪与懒惰**：\`.*\` 吃到不能再吃，\`.*?\` 吃到刚好就停
3. **断言**：\`(?=...)\` 后面是、\`(?<=...)\` 前面是、\`(?!...)\` 后面不是

## § 逐句拆一个真实的

\`\`\`text
(?<=v)(\d+)\.(?=\d)
\`\`\`

- \`(?<=v)\`：前面必须是字母 v
- \`(\d+)\`\：捕获一串数字
- \`\\.\`：一个点
- \`(?=\d)\`：后面必须还是数字

作用：从 \`v2.1\` 里抓出版本号 \`2\`。

## § 评审时的三条忠告

- 超过 40 字符的正则，请作者加注释或拆分
- 看到 \`.*\` 就问一句：会不会匹配过头？
- 涉及用户输入的正则，查一下 ReDoS（灾难性回溯）

能读懂，敢提问，这三十分钟就值了。
`,
  },
  {
    author: 1, slug: "docker-pitfalls-notes", cover: "舱", tags: ["运维", "后端"],
    title: "Docker 入门到脱坑：一个后端的容器化笔记",
    summary: "镜像越压越小、容器日志把磁盘写满、compose 里的数据库连不上——容器化路上必踩的坑，一篇笔记全收藏。",
    md: `# Docker 脱坑笔记

> 容器化不难，难的是每次都踩一样的坑。

## § 坑一：镜像比源码还大

FROM node:20 起步就 1GB。正确姿势是多阶段构建：

\`\`\`dockerfile
FROM node:20-slim AS build
COPY . .
RUN npm ci && npm run build

FROM node:20-slim
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
\`\`\`

再配一个 \`.dockerignore\`（node_modules、.git 必进），镜像从 1.2G 降到 180M。

## § 坑二：日志写满磁盘

json-file 驱动默认不限大小。全局兜底：

\`\`\`json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
\`\`\`

## § 坑三：容器连不上数据库

compose 里服务名就是主机名，写 \`localhost\` 必挂。要连宿主机用 \`host.docker.internal\`（记得加 extra_hosts）。

## § 一句话总结

镜像要瘦、日志要限、网络看命名。三件做对，90% 的容器事故与你无关。
`,
  },
  {
    author: 1, slug: "nginx-cheatsheet", cover: "N", tags: ["运维", "后端"],
    title: "Nginx 配置速查：反代、缓存与限流一页通",
    summary: "不求精通，只求抄了就能用。反向代理、静态资源缓存、接口限流三大场景的完整配置片段，每段附一句踩坑注释。",
    md: `# Nginx 一页通

> 抄了就能用的三段配置，比十篇教程好使。

## § 反向代理（最常用）

\`\`\`nginx
server {
  listen 80;
  server_name example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
\`\`\`

注意：不传 X-Forwarded-For，应用层拿到的永远是 127.0.0.1，限流会把全站用户当成同一个人。

## § 静态资源长缓存

\`\`\`nginx
location /_next/static/ {
  expires 365d;
  add_header Cache-Control "public, immutable";
}
\`\`\`

## § 接口限流

\`\`\`nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
location /api/ { limit_req zone=api burst=20 nodelay; }
\`\`\`

用 \`$binary_remote_addr\` 而不是 \`$remote_addr\`，省内存且支持 IPv6。
`,
  },
  {
    author: 1, slug: "linux-cpu-firefight", cover: "诊", tags: ["性能", "运维"],
    title: "Linux 排障三件套：top、strace 与一次 CPU 100% 的深夜",
    summary: "凌晨两点 CPU 打满， load 飙到 40。完整记录一次线上排障：从 top 定位进程，到 strace 抓系统调用，最后发现是一个 while 循环少了一行休眠。",
    md: `# CPU 100% 的深夜

> 排障的核心不是工具多炫，是排除法够不够快。

## § 现场

告警群炸了：CPU 98%，load 40，接口全超时。第一步永远是 \`top\`：

\`\`\`text
  PID USER      %CPU %MEM COMMAND
 8121 app       973  2.1  node
\`\`\`

一个 node 进程吃了十颗核。

## § strace 出手

\`\`\`bash
strace -cp 8121        # 统计这个进程在忙什么系统调用
\`\`\`

结果里 \`clock_gettime\` 占了 99%——进程在死循环里疯狂看时间。翻代码，找到了：

\`\`\`js
while (!done) { checkQueue(); }   // 没有休眠的自旋，CPU 的噩梦
\`\`\`

加上 \`await sleep(100)\`，CPU 从 973% 掉到 0.4%。

## § 复盘三条

1. \`top\` → \`strace -cp\` → 看代码，这条链路能解决一半的「突然打满」
2. 忙等待是新手最常见的设计味，**轮询不如事件**
3. 告警要带进程名，只说「CPU 高」等于只说「着火了」
`,
  },
  {
    author: 1, slug: "password-storage-right", cover: "钥", tags: ["安全", "后端"],
    title: "密码正确的存储姿势：bcrypt、argon2 与「加盐」的真相",
    summary: "MD5 加盐已经是上个时代的答案。从哈希函数的选择、盐的正确用法，到参数怎么调、泄露后怎么办，把密码存储一次讲透。",
    md: `# 密码存储的正确姿势

> 你存密码的方式，决定了被拖库那天你睡不睡得着。

## § 先排除错误答案

- **明文**：直接进新闻
- **MD5/SHA-256**：GPU 一秒算几十亿次，等于没加密
- **MD5+盐**：盐挡住了彩虹表，挡不住暴力枚举

## § 正确答案：慢哈希

\`\`\`js
// argon2id：目前的首选
import argon2 from "argon2";
const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456 });
const ok = await argon2.verify(hash, password);
\`\`\`

bcrypt 也合格（cost 12 起）。它们的共同点是**故意慢**——用户登录慢 200ms 无感，攻击者枚举一次要慢一亿倍。

## § 盐不用你管

argon2/bcrypt 自动生成盐并拼进哈希串里。自己拿 MD5 手动拼盐，属于「用胶带修保险柜」。

## § 泄露后的标准动作

强制全站改密（会话全吊销）→ 通知用户 → 排查入口。别删库跑路，也别装没事——**诚实是安全事故里最便宜的公关**。
`,
  },
  {
    author: 1, slug: "csrf-xss-lesson", cover: "盾", tags: ["安全", "前端"],
    title: "CSRF 与 XSS：一次被白帽小哥教育的过程复盘",
    summary: "收到一封漏洞报告邮件的那天，才明白「能跑」和「能防」差了多远。复盘 XSS 存储型漏洞与 CSRF 的修复全过程，附最简防御清单。",
    md: `# 被白帽小哥教育的一天

> 漏洞报告邮件的开头都很客气，结尾都很扎心。

## § 漏洞一：存储型 XSS

评论区没转义就渲染，白帽提交了一篇正文里带 \`<script>\` 的评论，所有打开页面的人的 cookie 都发了他的服务器。

修复三板斧：

1. **输出转义**：默认框架的 JSX/模板转义别手贱关掉，\`dangerouslySetInnerHTML\` 前先过白名单（DOMPurify）
2. **Cookie 加 httpOnly**：JS 读不到，偷走也没用
3. **CSP 兜底**：\`script-src 'self'\`，内联脚本直接报废

## § 漏洞二：CSRF

他构造了一个自动提交的表单页，用户点一下链接，就「自愿」改了邮箱。

修复：

- **SameSite=Lax cookie**（现代框架默认）挡掉绝大多数跨站请求
- **关键操作要求二次确认**：改邮箱、改密码必须验证旧凭证

## § 一张最小防御清单

转义输出、httpOnly、SameSite、CSP、最小权限。五件事做完，能挡掉互联网上 95% 的顺手攻击。
`,
  },
  {
    author: 1, slug: "homelab-ddns-guide", cover: "家", tags: ["工具", "安全"],
    title: "家庭宽带自建服务指南：DDNS、反代与证书续期",
    summary: "家里那台闲置小主机，其实能变成你的私人云。从动态域名、反向代理到 HTTPS 证书自动续期，一份不会让你半夜起来修服务器的指南。",
    md: `# 把家里的小主机变成私人云

> 云服务器月租三十块，家里吃灰的盒子分文不取。

## § 第一步：DDNS 解决「IP 会漂」

家宽公网 IP 不定期变，用 DDNS 客户端盯住它：

\`\`\`bash
# 每 5 分钟检查并更新 DNS 记录（以 Cloudflare 为例）
*/5 * * * * curl -s "https://api.cf/zone/$ZID/dns_records/$RID" \\
  -X PUT -H "Authorization: Bearer $T" \\
  -d "{\"type\":\"A\",\"name\":\"home.example.com\",\"content\":\"$IP\"}"
\`\`\`

## § 第二步：一台 Nginx 管所有服务

用子域名分流：\`home.example.com\` 走相册、\`nas.example.com\` 走网盘。证书用 certbot 自动续：

\`\`\`bash
certbot --nginx -d home.example.com -d nas.example.com
\`\`\`

systemd timer 会自动续期，从此告别「证书过期」红色告警。

## § 安全三条底线

1. **只开 443**，管理端口绝不暴露公网
2. **fail2ban 挂上**，暴力破解自动拉黑
3. 敏感服务套一层 **Basic Auth 或 VPN**（WireGuard 十分钟配好）

自建的快乐很实在，但记住：**家庭服务器的第一原则是别变成别人的肉鸡**。
`,
  },
  {
    author: 1, slug: "http-cache-decoded", cover: "存", tags: ["性能", "前端"],
    title: "HTTP 缓存从懵到懂：ETag、Cache-Control 实战对照表",
    summary: "强缓存、协商缓存、immutable、stale-while-revalidate——把最容易被背错的概念放回真实请求里，一张对照表讲清楚谁在什么时候生效。",
    md: `# HTTP 缓存从懵到懂

> 缓存策略背了八百遍，一到线上还是懵？因为缺一张「真实请求」对照表。

## § 一次请求的生命线

\`\`\`text
浏览器要 /app.js
 ├─ 本地有副本 & max-age 未过期 → 直接用，不发请求（强缓存）
 ├─ 过期了 → 带 If-None-Match 问服务器
 │    ├─ ETag 没变 → 304，开销几百字节
 │    └─ 变了 → 200，给新文件
\`\`\`

## § 关键头部怎么配

\`\`\`text
# 带 hash 的静态资源：一年强缓存 + immutable
Cache-Control: public, max-age=31536000, immutable

# HTML 入口：永远协商，保证更新立刻可见
Cache-Control: no-cache

# 接口：短缓存 + 过期后先用旧的再后台更新
Cache-Control: max-age=60, stale-while-revalidate=30
\`\`\`

## § 三条军规

1. **文件名带 hash 才敢配长缓存**，否则用户永远在用旧版本
2. HTML 入口配 \`no-cache\` 而不是 \`no-store\`，前者还走协商省流量
3. 调试时勾上 DevTools 的 Disable cache，别让缓存骗你

缓存调对了，第二次访问的速度提升是**数量级**的。
`,
  },
  {
    author: 1, slug: "rsc-one-year-later", cover: "R", tags: ["前端", "编程"],
    title: "React Server Components 一年后：真香还是真麻烦",
    summary: "用 RSC 重构了三个项目之后，聊聊它真正解决的问题、带来心智负担，以及什么项目根本不该用。",
    md: `# RSC 一年后

> Server Components 不是「服务端渲染 2.0」，是「组件的分界线重画」。

## § 真正解决的问题

以前数据获取的链路是：页面加载 → useEffect → 请求 → loading → 渲染。RSC 把这段搬进服务端：

\`\`\`tsx
// 这整块都不会进客户端 bundle
async function ArticleList() {
  const rows = await db.query("SELECT ...");
  return <ul>{rows.map(r => <li key={r.id}>{r.title}</li>)}</ul>;
}
\`\`\`

首屏快了、包小了、loading 态少了。**这三条是真香。**

## § 心智负担也是真的

- 「这个组件是 server 还是 client」要时刻清楚
- 传给 client 组件的 props 必须可序列化，函数传不过去
- 一处加 "use client"，边界下游全变客户端，包体积悄悄回涨

## § 什么项目别用

纯静态营销页（SSG 就够）、重交互的编辑器类应用（客户端组件占 90%，RSC 收益趋零）。

结论：**数据密集的中后台和内容站，RSC 值得；交互密集的工具类，观望不亏。**
`,
  },
  {
    author: 1, slug: "css-container-query", cover: "容", tags: ["前端", "设计"],
    title: "CSS 容器查询：响应式设计的第二次革命",
    summary: "媒体查询看的是屏幕，容器查询看的是组件自己。一个组件放进侧边栏自动变紧凑、放进主栏自动舒展——这才是真正的组件化响应式。",
    md: `# 容器查询：组件自己决定怎么响应

> 媒体查询问「屏幕多宽」，容器查询问「我住的地方多宽」。

## § 三行启用

\`\`\`css
.card-wrap { container-type: inline-size; }

@container (max-width: 400px) {
  .card { flex-direction: column; }
  .card img { width: 100%; }
}
\`\`\`

同一张卡片，塞进 300px 的侧边栏自动竖排，放进 800px 的主栏自动横排。**组件终于可移植了。**

## § 配套单位：cqi

\`\`\`css
.card h3 { font-size: clamp(14px, 6cqi, 22px); }
\`\`\`

\`6cqi\` = 容器宽度的 6%，字号跟着容器而不是跟视口走。

## § 迁移建议

别一口气重写全站。从「会在多处复用的组件」开始改：卡片、列表项、导航。改完你会发现 media query 里一大半断点查询都是多余的——它们本来就不该由屏幕决定。

这是自 flexbox 之后，CSS 第一次真正改变布局思路的更新。
`,
  },
  {
    author: 1, slug: "webaudio-tuner", cover: "律", tags: ["前端", "工具"],
    title: "用 Web Audio 做一个调音器：浏览器里的信号处理",
    summary: "不用任何后端，浏览器拿到麦克风采样、做 FFT、算出琴弦偏差音分。一个周末小项目的完整技术拆解。",
    md: `# 浏览器调音器

> 一把吉他、一个麦克风权限、两百行 JS——周末项目的标准配方。

## § 拿到声音

\`\`\`js
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const ctx = new AudioContext();
const analyser = ctx.createAnalyser();
analyser.fftSize = 8192;               // 分辨率越高，音准越细
ctx.createMediaStreamSource(stream).connect(analyser);
\`\`\`

## § FFT 找基频

\`\`\`js
const buf = new Float32Array(analyser.fftSize);
analyser.getFloatTimeDomainData(buf);
// 自相关法找周期 → 频率 = 采样率 / 周期
\`\`\`

低音琴弦基频能低到 82Hz，fftSize 太小会把泛音误认成基频——这是本项目唯一的坑。

## § 音分换算

\`\`\`js
const cents = 1200 * Math.log2(freq / targetFreq);
// |cents| < 5 视为准了
\`\`\`

UI 上画一根指针，偏左是低、偏右是高。朋友试过之后说：比买的调音器还灵。**浏览器就是个被低估的信号处理器。**
`,
  },
  {
    author: 1, slug: "mysql-index-rules", cover: "引", tags: ["数据库", "后端"],
    title: "MySQL 索引设计的十条军规",
    summary: "从最左前缀到覆盖索引，从区分度到深分页，十条被无数慢查询验证过的索引军规，每条配一个真实翻车案例。",
    md: `# MySQL 索引十条军规

> 索引不是加得越多越好，是加得越准越好。

## § 军规十条

1. **最左前缀**：联合索引 (a,b,c) 救不了只有 b 的查询
2. **区分度优先**：性别列建索引等于白建，选择性低于 10% 的列别建
3. **覆盖索引**：查询列都在索引里，回表归零，速度质变
4. **别在索引列上做运算**：\`WHERE YEAR(created_at)=2026\` 直接全表扫
5. **前缀索引省空间**：长字符串用 \`INDEX(email(20))\`
6. **排序列进索引**：\`ORDER BY created_at DESC\` 没索引就是 filesort
7. **单表索引 ≤ 5 个**：每个索引都是写入的税
8. **深分页用游标**：\`WHERE id > last_id LIMIT 20\`，别 \`LIMIT 100000,20\`
9. **唯一约束交给数据库**：代码判重都有并发窗口
10. **上线前 EXPLAIN**：type 是 ALL 的 SQL 不许出门

## § 一条体会

索引设计的本质是**预测查询**。先想清楚这张表会被怎么查，再决定怎么存——顺序反了，索引就变成了库存。
`,
  },
  {
    author: 1, slug: "tx-isolation-mvcc", cover: "锁", tags: ["数据库", "编程"],
    title: "事务隔离级别图文讲透：脏读、幻读与 MVCC",
    summary: "四个隔离级别不是用来背的，是用来躲坑的。用「两个窗口改同一行」的图景讲清脏读、不可重复读、幻读的区别，以及 MVCC 到底在忙什么。",
    md: `# 事务隔离级别讲透

> 隔离级别回答的是一个问题：你愿意为了正确性，放弃多少并发？

## § 四级速查

\`\`\`text
读未提交   → 会看到别人没提交的数据（脏读），几乎没人用
读已提交   → 只看已提交的，但两次读结果可能不同（不可重复读）
可重复读   → 同一事务内读到的数据一致（MySQL 默认）
串行化     → 绝对安全，慢到怀疑人生
\`\`\`

## § 幻读是什么感觉

事务 A 两次执行 \`SELECT COUNT(*) WHERE amount > 100\`，中间事务 B 插入了一行——两次计数不同。像见鬼，其实是新行「幻影般」出现。

## § MVCC 在忙什么

InnoDB 给每行藏了版本链和快照：读操作不加锁，而是沿版本链找到自己事务开始时的那个「旧世界」。**读写互不阻塞**，这就是 MySQL 默认级别下并发性能好的原因。

## § 什么时候手动升级

对账、扣款这类「先读后写」的场景，别指望隔离级别，直接 \`SELECT ... FOR UPDATE\` 把行锁住。**隔离级别是兜底，悲观锁才是保险。**
`,
  },
  {
    author: 1, slug: "redis-cache-3qs", cover: "雪", tags: ["数据库", "后端"],
    title: "Redis 缓存三问：穿透、击穿、雪崩怎么防",
    summary: "三个名字很像的故障，三种完全不同的药方。一张决策表 + 各一段可用代码，把缓存架构师面试最爱问的三连一次说清。",
    md: `# 缓存三问

> 穿透、击穿、雪崩——名字像三胞胎，病因完全不沾亲。

## § 一张表分清

\`\`\`text
穿透：查「根本不存在」的数据，缓存永远不命中，DB 被打穿
击穿：一个「热点 key」过期的瞬间，海量请求直冲 DB
雪崩：大批 key「同一时刻」集体过期，DB 被人海战术淹没
\`\`\`

## § 药方

**穿透**：缓存空值（短 TTL）+ 入口参数校验，别让 -1 这种 ID 进来。

**击穿**：热点 key 逻辑过期不删除 + 互斥锁重建：

\`\`\`js
const lock = await redis.set(key+":lock", 1, "NX", "EX", 5);
if (lock) { await rebuildCache(key); }
\`\`\`

**雪崩**：过期时间加随机抖动 \`ttl + random(0, 300)\`，把过期时间摊开。

## § 一条元认知

三问的本质是同一件事：**缓存与 DB 的一致性窗口里，请求去哪了。** 想通这句，以后遇到缓存的新花样（布隆过滤器、多级缓存），自己就能推出来该怎么配。
`,
  },
  {
    author: 2, slug: "sqlite-enough", cover: "轻", tags: ["数据库", "工具"],
    title: "SQLite 也很好：小项目的数据库选型避执念指南",
    summary: "不是每个项目都需要 MySQL 集群。十万行以下、单机、低并发的场景里，SQLite 的零运维是生产力本身。附适合与不适合的判断清单。",
    md: `# SQLite 也很好

> 技术选型最大的执念：项目还没上线，先想好了百万并发。

## § 什么时候 SQLite 就够

- 单机部署（个人博客、小工具、桌面应用）
- 写并发低（SQLite 写锁是库级的，一秒几十个写事务很稳）
- 数据量百万行以内

一个文件就是整个数据库：

\`\`\`bash
sqlite3 blog.db ".backup backup.db"    # 备份 = 复制文件
\`\`\`

**没有用户、没有端口、没有配置文件**，部署脚本从 40 行变成 3 行。

## § 什么时候必须换

- 多台机器要写同一个库
- 高并发写入（秒杀、计数器）
- 需要丰富的权限体系

## § 我的判断清单

每次新项目先问三个问题：部署在哪？几个人用？写多读少还是读多写少？三个答案都指向「小」，那就 SQLite——**把省下来的运维时间，拿去写真正的功能**。
`,
  },
];
