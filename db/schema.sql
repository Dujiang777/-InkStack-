-- 墨栈 InkStack · MySQL 建表脚本（P0）
-- 用法：mysql -u root -p < db/schema.sql

CREATE DATABASE IF NOT EXISTS inkstack
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE inkstack;

-- 用户表（P0：role = reader | author | admin）
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nickname      VARCHAR(64)  NOT NULL,
  email         VARCHAR(128) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar_text   VARCHAR(8)   NOT NULL DEFAULT '墨',
  avatar_tone   VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '印泥色（v17.4）：""=随缘派定 | ink | 色板 key（lib/avatar.ts）',
  avatar_shape  VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '印式（v17.4）：""=圆章 | fang 方章 | yangwen 阳文',
  bio           VARCHAR(255) NULL,
  role          ENUM('reader','author','admin','developer') NOT NULL DEFAULT 'reader',
  points_balance INT NOT NULL DEFAULT 100,
  last_quota_date DATE NULL COMMENT '每日免费额度懒重置标记（最近一次发放日）',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 文章表（P0：md_content 存 Markdown，发布时触发审核与向量化——向量库 P1 用独立表/服务）
CREATE TABLE IF NOT EXISTS articles (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  author_id     BIGINT UNSIGNED NOT NULL,
  slug          VARCHAR(160) NOT NULL UNIQUE,
  title         VARCHAR(200) NOT NULL,
  md_content    MEDIUMTEXT   NOT NULL,
  summary       VARCHAR(500) NULL,
  cover_label   VARCHAR(32)  NULL COMMENT '编辑风封面编号/栏目字',
  tags          JSON         NULL,
  status        ENUM('draft','published','removed') NOT NULL DEFAULT 'draft',
  pinned        TINYINT(1) NOT NULL DEFAULT 0 COMMENT '运营置顶（信息流最前）',
  featured      TINYINT(1) NOT NULL DEFAULT 0 COMMENT '编辑精选标识',
  read_count    INT UNSIGNED NOT NULL DEFAULT 0,
  comment_count INT UNSIGNED NOT NULL DEFAULT 0,
  agent_qa_count INT UNSIGNED NOT NULL DEFAULT 0,
  unlock_price  INT NOT NULL DEFAULT 0 COMMENT '付费解锁定价（点墨），0=免费',
  discount_price INT NULL COMMENT '早鸟折扣价（0<折扣<原价时生效）',
  discount_until DATETIME NULL COMMENT '早鸟价截止时间',
  paywall_views INT NOT NULL DEFAULT 0 COMMENT '付费墙到达次数（转化漏斗埋点）',
  published_at  DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_pub (status, published_at DESC),
  -- RAG 检索用：ngram 分词器支持中文全文检索（MySQL 5.7.6+）
  FULLTEXT KEY ft_articles (title, md_content) WITH PARSER ngram,
  CONSTRAINT fk_article_author FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 评论表（一级 + 楼中楼；P0 先开放游客昵称评论，接登录后绑定 user_id）
CREATE TABLE IF NOT EXISTS comments (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  article_id     BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NULL,
  guest_nickname VARCHAR(64) NULL COMMENT '游客昵称（未登录时）',
  parent_id      BIGINT UNSIGNED NULL,
  content        VARCHAR(2000) NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_comment_article (article_id, created_at),
  CONSTRAINT fk_c_article FOREIGN KEY (article_id) REFERENCES articles(id),
  CONSTRAINT fk_c_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 关注关系
CREATE TABLE IF NOT EXISTS follows (
  follower_id BIGINT UNSIGNED NOT NULL,
  followee_id BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followee_id)
) ENGINE=InnoDB;

-- 博主分身配置（P0：RAG 版，P1 每人独立文风档案）
CREATE TABLE IF NOT EXISTS agent_configs (
  user_id     BIGINT UNSIGNED PRIMARY KEY,
  is_enabled  TINYINT(1) NOT NULL DEFAULT 0,
  tone        ENUM('rigorous','humorous','concise') NOT NULL DEFAULT 'rigorous',
  deny_list   JSON NULL COMMENT '禁答关键词清单',
  review_mode TINYINT(1) NOT NULL DEFAULT 1 COMMENT '回复是否需博主复核',
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 分身问答记录（citations 存来源段落，feedback = up | down | NULL）
CREATE TABLE IF NOT EXISTS agent_qa (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  article_id BIGINT UNSIGNED NULL,
  asker_id   BIGINT UNSIGNED NULL,
  question   VARCHAR(1000) NOT NULL,
  answer     TEXT NOT NULL,
  citations  JSON NULL,
  feedback   ENUM('up','down') NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qa_article (article_id, created_at)
) ENGINE=InnoDB;

-- 积分流水（免费每日 100，写作 10/次，问答 2/次；P0 不卖充值）
CREATE TABLE IF NOT EXISTS point_ledger (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  delta      INT NOT NULL,
  reason     VARCHAR(120) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_point_user (user_id, created_at),
  CONSTRAINT fk_point_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 行为奖励防刷计数（每用户×行为×自然日一条；带上限奖励先计数再发分）
CREATE TABLE IF NOT EXISTS reward_counters (
  user_id  BIGINT UNSIGNED NOT NULL,
  cap_key  VARCHAR(64) NOT NULL,
  cnt_day  DATE NOT NULL,
  cnt      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, cap_key, cnt_day),
  CONSTRAINT fk_reward_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 充值订单（P0：演示支付通道，status pending→paid；P1 接微信支付 Native 下单+回调验签）
CREATE TABLE IF NOT EXISTS topup_orders (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  order_no     VARCHAR(40) NOT NULL UNIQUE,
  pack_key     VARCHAR(32) NOT NULL,
  amount_cents INT NOT NULL COMMENT '应付金额（分）',
  points       INT NOT NULL COMMENT '到账点墨',
  status       ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  channel      VARCHAR(24) NULL COMMENT '支付渠道：demo | wechat | alipay',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at      DATETIME NULL,
  INDEX idx_topup_user (user_id, created_at DESC),
  CONSTRAINT fk_topup_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 文章加热（作者花 80 墨买 24h 信息流加权，可叠加延长）
CREATE TABLE IF NOT EXISTS article_boosts (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  article_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  boost_until DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_boost_article (article_id, boost_until),
  CONSTRAINT fk_boost_article FOREIGN KEY (article_id) REFERENCES articles(id),
  CONSTRAINT fk_boost_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 墨水打赏（读者 → 作者，平台抽成 10%）
CREATE TABLE IF NOT EXISTS article_tips (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  article_id BIGINT UNSIGNED NOT NULL,
  from_user  BIGINT UNSIGNED NOT NULL,
  to_user    BIGINT UNSIGNED NOT NULL,
  amount     INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tip_article (article_id, created_at DESC),
  CONSTRAINT fk_tip_article FOREIGN KEY (article_id) REFERENCES articles(id),
  CONSTRAINT fk_tip_from FOREIGN KEY (from_user) REFERENCES users(id),
  CONSTRAINT fk_tip_to FOREIGN KEY (to_user) REFERENCES users(id)
) ENGINE=InnoDB;

-- 演示博主
INSERT INTO users (nickname, email, password_hash, avatar_text, bio, role) VALUES
  ('陈屿', 'chenyu@inkstack.dev', 'SEED_ONLY', '陈', '系统架构 · 异步编程系列作者 · 分身在线中', 'author'),
  ('林晚', 'linwan@inkstack.dev', 'SEED_ONLY', '林', 'Agent 工程实践者', 'author')
ON DUPLICATE KEY UPDATE nickname=VALUES(nickname);

-- 演示文章元信息（正文由 scripts/seed.mjs 写入）
-- 演示文章元信息（正文由 scripts/seed.mjs 写入）
-- author_id 按 email 动态解析，避免自增 ID 漂移导致外键失败
SET @chenyu = (SELECT id FROM users WHERE email = 'chenyu@inkstack.dev');
SET @linwan = (SELECT id FROM users WHERE email = 'linwan@inkstack.dev');

INSERT INTO articles (author_id, slug, title, md_content, summary, cover_label, status, read_count, comment_count, agent_qa_count, published_at) VALUES
  (@chenyu, 'shou-xie-promise', '手写 Promise：从零实现，到理解事件循环的边界条件', '# 占位\n\n正文由 scripts/seed.mjs 写入。', '从零手写一个符合 Promises/A+ 规范的实现，并处理两个最容易被忽略的边界条件。', '卷一', 'published', 12840, 132, 1284, NOW() - INTERVAL 3 DAY),
  (@linwan, 'wenfeng-dangan', '给每个博主训练一个「文风档案」，比微调模型便宜一百倍', '# 占位\n\n正文由 scripts/seed.mjs 写入。', '文风不是玄学：它可以从 20 篇历史文章里蒸馏成一份结构化 Prompt 档案。', '卷二', 'published', 4200, 87, 302, NOW() - INTERVAL 1 DAY),
  (@chenyu, 'pgvector-gou-yong', 'pgvector 够用了：别急着上专用向量库', '# 占位\n\n正文由 scripts/seed.mjs 写入。', '技术选型最大的陷阱，是把「别人的规模」当成自己的规模。', '卷三', 'published', 3800, 64, 96, NOW() - INTERVAL 5 HOUR)
ON DUPLICATE KEY UPDATE title=VALUES(title);

-- 草稿表（创作台自动保存；P0 每用户按文件名一份，同名覆盖）
CREATE TABLE IF NOT EXISTS drafts (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  title      VARCHAR(200) NOT NULL,
  content    MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_draft (user_id, title),
  CONSTRAINT fk_draft_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 链接白名单/审核（文章外链域名放行表）
CREATE TABLE IF NOT EXISTS link_whitelist (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  domain     VARCHAR(200) NOT NULL UNIQUE,
  url        VARCHAR(500) NULL,
  note       VARCHAR(200) NULL,
  status     ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_link_status (status, created_at DESC)
) ENGINE=InnoDB;

-- 每日签到（积分补给来源之一；唯一主键天然防重复签到，连续天数由查询侧计算）
CREATE TABLE IF NOT EXISTS checkins (
  user_id      BIGINT UNSIGNED NOT NULL,
  checkin_date DATE NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, checkin_date),
  CONSTRAINT fk_checkin_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 上传文件登记（图片等资产，本地磁盘 public/uploads + 库内索引）
CREATE TABLE IF NOT EXISTS uploads (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NULL,
  filename   VARCHAR(255) NOT NULL,
  mime       VARCHAR(80) NOT NULL,
  size       INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_upload_user (user_id, created_at DESC)
) ENGINE=InnoDB;

-- ===== 第十一轮：审核流 / 封禁 / 举报 / 管理日志 / 通知 / 点赞 =====

-- 文章审核流：普通用户发文 → pending，admin 通过后公开；驳回带 review_note 通知作者
-- （存量文章经 DEFAULT 'approved' 回填，不破坏现状）
ALTER TABLE articles
  ADD COLUMN review_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'approved' AFTER status,
  ADD COLUMN review_note VARCHAR(255) NULL AFTER review_status,
  ADD COLUMN like_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER agent_qa_count,
  ADD INDEX idx_review (review_status);

-- 账号封禁（封禁后 getCurrentUser 直接视为未登录）
ALTER TABLE users ADD COLUMN banned TINYINT(1) NOT NULL DEFAULT 0 AFTER role;

-- 文章点赞（联合主键天然防重复，计数冗余在 articles.like_count）
CREATE TABLE IF NOT EXISTS article_likes (
  user_id    BIGINT UNSIGNED NOT NULL,
  article_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, article_id),
  CONSTRAINT fk_alike_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_alike_article FOREIGN KEY (article_id) REFERENCES articles(id)
) ENGINE=InnoDB;

-- 举报（读者举报文章/评论，运营台处理队列；处理动作：删内容/保留/忽略）
CREATE TABLE IF NOT EXISTS reports (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reporter_id BIGINT UNSIGNED NULL,
  target_type ENUM('article','comment') NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  reason      VARCHAR(255) NOT NULL,
  status      ENUM('open','resolved','dismissed') NOT NULL DEFAULT 'open',
  handle_note VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at  DATETIME NULL,
  INDEX idx_report_status (status, created_at DESC),
  CONSTRAINT fk_report_user FOREIGN KEY (reporter_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 管理操作审计日志（运营台全部敏感动作落库可追溯）
CREATE TABLE IF NOT EXISTS admin_actions (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id    BIGINT UNSIGNED NOT NULL,
  action      VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id   VARCHAR(64) NOT NULL,
  detail      VARCHAR(500) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_adminlog (created_at DESC),
  CONSTRAINT fk_adminlog_user FOREIGN KEY (admin_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 站内通知（评论/打赏/点赞/审核结果/封禁等，顶栏铃铛 + /notifications 页）
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  type       ENUM('comment','tip','review','like','unlock','system') NOT NULL DEFAULT 'system',
  title      VARCHAR(200) NOT NULL,
  body       VARCHAR(500) NULL,
  link       VARCHAR(255) NULL,
  is_read    TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_user (user_id, is_read, created_at DESC),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 关注关系（作者-读者双向查询：粉丝数/关注列表/是否已关注）
CREATE TABLE IF NOT EXISTS follows (
  follower_id BIGINT UNSIGNED NOT NULL,
  followee_id BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followee_id),
  INDEX idx_followee (followee_id),
  CONSTRAINT fk_fol_follower FOREIGN KEY (follower_id) REFERENCES users(id),
  CONSTRAINT fk_fol_followee FOREIGN KEY (followee_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 书签收藏（运行时也会懒建，这里保证全新装库一次到位）
CREATE TABLE IF NOT EXISTS bookmarks (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  article_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bm (user_id, article_id),
  INDEX idx_bm_user (user_id, created_at DESC),
  CONSTRAINT fk_bm_article FOREIGN KEY (article_id) REFERENCES articles(id)
) ENGINE=InnoDB;

-- 阅读历史（运行时也会懒建，这里保证全新装库一次到位）
CREATE TABLE IF NOT EXISTS read_history (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  article_id BIGINT UNSIGNED NOT NULL,
  read_times INT UNSIGNED NOT NULL DEFAULT 1,
  read_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rh (user_id, article_id),
  INDEX idx_rh_user (user_id, read_at DESC),
  CONSTRAINT fk_rh_article FOREIGN KEY (article_id) REFERENCES articles(id)
) ENGINE=InnoDB;

-- 专栏合集（运行时也会懒建，这里保证全新装库一次到位）
CREATE TABLE IF NOT EXISTS series (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  author_id   BIGINT UNSIGNED NOT NULL,
  title       VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  bundle_price INT NULL COMMENT '打包一口价（NULL/0 = 不开放打包）',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_series_author (author_id),
  CONSTRAINT fk_series_author FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS series_items (
  series_id  BIGINT UNSIGNED NOT NULL,
  article_id BIGINT UNSIGNED NOT NULL,
  position   INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, article_id),
  CONSTRAINT fk_si_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  CONSTRAINT fk_si_article FOREIGN KEY (article_id) REFERENCES articles(id)
) ENGINE=InnoDB;

-- 专栏打包购买记录（运行时懒建；篇目明细按 70/30 分摊落 article_purchases）
CREATE TABLE IF NOT EXISTS series_purchases (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  series_id   BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  price       INT NOT NULL,
  author_gain INT NOT NULL DEFAULT 0,
  item_count  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_series_purchase (series_id, user_id),
  INDEX idx_sp_user (user_id, created_at DESC),
  CONSTRAINT fk_sp_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 注册邮箱验证码（运行时懒建；sha256 落库，10 分钟有效，5 次尝试上限）
CREATE TABLE IF NOT EXISTS email_codes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(190) NOT NULL,
  code_hash  CHAR(64) NOT NULL,
  purpose    VARCHAR(20) NOT NULL DEFAULT 'register',
  attempts   INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_ec_email (email, created_at DESC)
) ENGINE=InnoDB;

-- 付费解锁记录（运行时懒建，这里保证全新装库一次到位）
CREATE TABLE IF NOT EXISTS article_purchases (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  article_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  price      INT NOT NULL,
  author_gain INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_purchase (article_id, user_id),
  INDEX idx_pur_user (user_id, created_at DESC),
  CONSTRAINT fk_pur_article FOREIGN KEY (article_id) REFERENCES articles(id),
  CONSTRAINT fk_pur_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- v13.5 安全巅峰轮：数据库会话 / 审计日志 / 2FA
-- ============================================================

-- 服务器端会话表：支持设备管理 + 强制下线（无状态 Cookie 的升级版）
CREATE TABLE IF NOT EXISTS sessions (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  token_hash   CHAR(64) NOT NULL COMMENT '会话令牌 sha256 十六进制',
  ua           VARCHAR(255) NULL COMMENT '登录设备 User-Agent 摘要',
  ip           VARCHAR(64)  NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  revoked      TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uk_session_token (token_hash),
  INDEX idx_session_user (user_id, revoked),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 审计日志：登录/登出/注册/改密/2FA/下线等敏感操作全留痕
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NULL,
  event      VARCHAR(32) NOT NULL COMMENT 'login_ok/login_fail/2fa_fail/register/... ',
  ip         VARCHAR(64)  NULL,
  ua         VARCHAR(255) NULL,
  detail     VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_user (user_id, created_at DESC),
  INDEX idx_audit_event (event, created_at DESC)
) ENGINE=InnoDB;

-- users 表 2FA 列（已有库执行 ALTER；新库可并入 users 定义）
-- ALTER TABLE users ADD COLUMN totp_secret  VARCHAR(64) NULL;
-- ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0;
-- ALTER TABLE users ADD COLUMN totp_backup  TEXT NULL COMMENT '一次性备份码 sha256 JSON 数组';
