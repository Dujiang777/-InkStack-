#!/usr/bin/env node
// 从根目录 .env 派生 Java 侧数据源配置到 server/config/application-local.properties。
// 目的：两栈共用同一套凭据与同一个 SESSION_SECRET，避免手抄导致会话不互通。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const raw = env.DATABASE_URL;
if (!raw) throw new Error('.env 缺少 DATABASE_URL');
const u = new URL(raw);

const targetDb = process.argv.includes('--prod-schema') ? u.pathname.slice(1) : 'inkstack_j';
// useAffectedRows=true 是**双轨正确性开关**，不是性能项：
// Connector/J 默认给连接打上 CLIENT_FOUND_ROWS，UPDATE 的 affectedRows 回的是"匹配行数"；
// 而 mysql2 没打这个标志，回的是"真正改动的行数"。同一句 no-op UPDATE，
// Node 拿 0、Java 拿 1 —— 工程里到处在用 affectedRows 当"这行到底存不存在 / 是不是新号"的判据
// （专栏改柜、运营下架、OAuth 的 ON DUPLICATE KEY 建号分支），默认值会让 Java 把
// "值没变"读成"改成功了"、把重复登录读成"新建档"并补发欢迎邮件。
const jdbc =
  `jdbc:mysql://${u.hostname}:${u.port || 3306}/${targetDb}` +
  '?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia%2FShanghai&useSSL=false'
  + '&allowPublicKeyRetrieval=true&useAffectedRows=true';

// "没给"与"给了空串"必须分开判：Spring 的 `${A:B}` 只在 A **完全没定义**时才回落到 B，
// 把空串写进 properties 会静默吃掉回落。表现就是运营按 DEPLOY.md 只填了 DEEPSEEK_API_KEY
// 和 AGENT_ENGINE=spring-ai，引擎却因为 AGENT_MODEL_API_KEY= 是空串而没起来，
// /api/agent/status 报 live —— 一个"开关开了、Key 没读到"的半开态，最难查。
const firstSet = (...vs) => vs.map((v) => (v ?? '').trim()).find((v) => v) ?? '';
const aiDeepseekKey = process.env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY ?? '';

const out = [
  '# 由 scripts/gen-java-env.mjs 生成，勿提交、勿手改',
  `INKSTACK_DB_URL=${jdbc}`,
  `INKSTACK_DB_USER=${decodeURIComponent(u.username)}`,
  `INKSTACK_DB_PASSWORD=${decodeURIComponent(u.password)}`,
  `SESSION_SECRET=${env.SESSION_SECRET ?? ''}`,
  `NEXT_PUBLIC_SITE_URL=${env.NEXT_PUBLIC_SITE_URL ?? ''}`,
  `TRUST_PROXY=${env.TRUST_PROXY ?? '0'}`,
  // 邮件与运行环境：Java 进程不继承 .env，这些必须显式派生，
  // 否则同一份配置会出现"Node 真发、Java 走 dev 降级"或"一侧回显 devCode 一侧不回显"的假差异。
  `NODE_ENV=${env.NODE_ENV ?? 'development'}`,
  `SMTP_HOST=${env.SMTP_HOST ?? ''}`,
  `SMTP_PORT=${env.SMTP_PORT || '465'}`,
  `SMTP_USER=${env.SMTP_USER ?? ''}`,
  `SMTP_PASS=${env.SMTP_PASS ?? ''}`,
  `SMTP_FROM=${env.SMTP_FROM ?? ''}`,
  // 第三方登录凭证：缺任一项该家即"未配置"，两栈必须给出同一个布尔值，
  // 否则 /api/auth/providers 对拍会假失败、前端气泡也会一边亮一边灭。
  `GITHUB_CLIENT_ID=${env.GITHUB_CLIENT_ID ?? ''}`,
  `GITHUB_CLIENT_SECRET=${env.GITHUB_CLIENT_SECRET ?? ''}`,
  `GITEE_CLIENT_ID=${env.GITEE_CLIENT_ID ?? ''}`,
  `GITEE_CLIENT_SECRET=${env.GITEE_CLIENT_SECRET ?? ''}`,
  `QQ_CLIENT_ID=${env.QQ_CLIENT_ID ?? ''}`,
  `QQ_CLIENT_SECRET=${env.QQ_CLIENT_SECRET ?? ''}`,
  // AI 分身的两个开关：GET /api/agent/status 的 mode 是"三档里当前是哪一档"，
  // 判据完全来自这两个值——一侧派生、另一侧不派生，徽标就会一边亮一边灭，
  // 而且"没配 Key 就不该真调大模型"这条计费/隐私前提会变成只有一边成立。
  // 取 process.env 优先：Next 读 .env 时**不会覆盖**已存在的环境变量，所以 Node 看到的
  // 就是 shell 里那一份；properties 里写空串等于假装"两边都没配"，换台机器起 Java 就分叉了。
  `AGENT_SERVICE_URL=${process.env.AGENT_SERVICE_URL ?? env.AGENT_SERVICE_URL ?? ''}`,
  `DEEPSEEK_API_KEY=${aiDeepseekKey}`,
  `DEEPSEEK_BASE_URL=${process.env.DEEPSEEK_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'}`,
  // Java 侧智能体引擎（P6c 起顶掉 Python 的 agent-service）。这四个值一起决定
  // /api/agent/status 报哪一档，也决定"会不会真去问大模型"，所以必须显式派生而不是留空：
  // 开关 off 或 Key 为空时引擎不构造，两侧行为都退回演示档。
  `AGENT_ENGINE=${process.env.AGENT_ENGINE ?? env.AGENT_ENGINE ?? 'off'}`,
  `AGENT_MODEL_BASE_URL=${process.env.AGENT_MODEL_BASE_URL ?? env.AGENT_MODEL_BASE_URL ?? 'https://api.deepseek.com/v1'}`,
  `AGENT_MODEL_API_KEY=${firstSet(process.env.AGENT_MODEL_API_KEY, env.AGENT_MODEL_API_KEY, aiDeepseekKey)}`,
  `AGENT_MODEL_NAME=${process.env.AGENT_MODEL_NAME ?? env.AGENT_MODEL_NAME ?? 'deepseek-chat'}`,
  // 图片上传落盘目录。Java 进程的工作目录是 server/（spring-boot:run 的 basedir），
  // 而双轨期这些文件是 Next 从 public/uploads 直接伺服的——不写同一个目录，
  // 表现就是"上传成功、URL 也回来了、图片却 404"，且两侧各测各的都发现不了。
  // 必须写正斜杠：.properties 里反斜杠是转义符，`\uploads` 会被当成 \u 统一码转义起手，
  // 整个配置文件直接解析失败（Windows 上 Java 认正斜杠路径）。
  `INKSTACK_UPLOAD_DIR=${path.join(root, "public", "uploads").replace(/\\/g, "/")}`,
  // 建库开关：Java 进程读的是这份 properties 而不是 .env，所以运维在 .env 里写
  // INKSTACK_SCHEMA_AUTO=false 必须被派生过来，否则 DEPLOY.md 那一行是假的。
  // 判空走 firstSet 而不是留给占位符回落：一行空的 `INKSTACK_SCHEMA_AUTO=` 会把
  // application.yml 的 `:true` 默认值盖成空串，DBA 关不掉建库反倒引入了第三种取值。
  `INKSTACK_SCHEMA_AUTO=${firstSet(process.env.INKSTACK_SCHEMA_AUTO, env.INKSTACK_SCHEMA_AUTO, 'true')}`,
  // RSS 抓取的私网黑名单总闸：两栈必须读同一个值，否则"一侧允许本机订阅源、另一侧一律拒绝"
  // 会变成对拍里最难解释的那种红。默认不透传——未设置时 Java 侧按 0 处理，与 Node 同。
  ...(process.env.IMPORT_ALLOW_PRIVATE || env.IMPORT_ALLOW_PRIVATE
    ? [`IMPORT_ALLOW_PRIVATE=${process.env.IMPORT_ALLOW_PRIVATE || env.IMPORT_ALLOW_PRIVATE}`]
    : []),
  "",
].join('\n');

const dir = path.join(root, 'server', 'config');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'application-local.properties'), out, 'utf8');
console.log(`已写入 server/config/application-local.properties（库：${targetDb}）`);
