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
  // 图片上传落盘目录。Java 进程的工作目录是 server/（spring-boot:run 的 basedir），
  // 而双轨期这些文件是 Next 从 public/uploads 直接伺服的——不写同一个目录，
  // 表现就是"上传成功、URL 也回来了、图片却 404"，且两侧各测各的都发现不了。
  // 必须写正斜杠：.properties 里反斜杠是转义符，`\uploads` 会被当成 \u 统一码转义起手，
  // 整个配置文件直接解析失败（Windows 上 Java 认正斜杠路径）。
  `INKSTACK_UPLOAD_DIR=${path.join(root, "public", "uploads").replace(/\\/g, "/")}`,
  "",
].join('\n');

const dir = path.join(root, 'server', 'config');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'application-local.properties'), out, 'utf8');
console.log(`已写入 server/config/application-local.properties（库：${targetDb}）`);
