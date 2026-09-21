// POST /api/import — 博主迁移工具：RSS 抓取 / Markdown 批量导入
// 获客钩子：「一键迁移旧文章 → 自动生成分身知识库」
// - 需登录（导入进自己的账号，分身全文索引即时生效）
// - 需 MySQL（演示模式不持久化，直接拒绝并说明）
// - 单次 ≤20 条/文件；同作者同名文章自动跳过；slug 冲突自动加序号
// - SSRF 防护：RSS 源解析后命中私网/环回地址一律拒绝（IMPORT_ALLOW_PRIVATE=1 可放行，仅供本机调试）
// - P1 待办：DOMPurify 完整消毒
import { lookup } from "node:dns/promises";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPool, dbEnabled } from "@/lib/db";
import { parseFeed, parseMarkdownFile, makeSlug, type ImportItem } from "@/lib/importer";

const MAX_ITEMS = 20;
const MAX_XML = 2_000_000;
const MAX_MD_FILE = 300_000;

/* ---------- SSRF 防护：私网 / 环回地址黑名单 ---------- */
const ALLOW_PRIVATE = process.env.IMPORT_ALLOW_PRIVATE === "1";

function ipv4Private(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true; // 本网络 / 内网 / 环回
  if (a === 169 && b === 254) return true; // 链路本地（云厂商元数据常见）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function ipv6Private(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true; // 链路本地
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // ULA
  if (s.startsWith("::ffff:")) return ipv4Private(s.slice(7)); // IPv4 映射地址
  return false;
}

// 返回拒绝原因；null = 放行。主机名统一先做 DNS 解析，按解析结果（含全部 A/AAAA）判断。
async function isBlockedHost(rawUrl: string): Promise<string | null> {
  if (ALLOW_PRIVATE) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "RSS 地址无法解析";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return "禁止抓取内网/本机地址";
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return "RSS 主机名无法解析，请确认地址可公开访问";
  }
  for (const { address, family } of addrs) {
    const hit = family === 4 ? ipv4Private(address) : ipv6Private(address);
    if (hit) return "禁止抓取内网/环回地址（安全防护）";
  }
  return null;
}

async function slugTaken(pool: NonNullable<Awaited<ReturnType<typeof getPool>>>, slug: string) {
  const [rows] = await pool.query("SELECT 1 FROM articles WHERE slug = ? LIMIT 1", [slug]);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 抓取订阅源（v17.2 严重级修复：防重定向绕过 SSRF 黑名单）。
 *
 * 修复前：`fetch(url)` 默认 redirect:"follow"，isBlockedHost 只校验**首跳**地址，
 * 于是攻击者用一个公开域名 302 到 http://169.254.169.254/...（云元数据）或任意内网地址，
 * 即可绕过私网黑名单——响应体还会被 parseFeed 解析、导入攻击者自己的草稿（可外带内网内容），
 * 失败时返回的 `订阅源返回 ${status}` 又成了内网探活 oracle。
 * 现在：redirect 改为 manual，逐跳复用 isBlockedHost 校验，最多 3 跳。
 */
const MAX_REDIRECTS = 3;

type FeedFetch = { ok: true; res: Response } | { ok: false; error: string };

async function fetchFeedSafely(url: string): Promise<FeedFetch> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await isBlockedHost(target);
    if (blocked) return { ok: false, error: blocked };
    let res: Response;
    try {
      res = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "InkStackBot/0.1 (+https://inkstack.dev)" },
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return { ok: false, error: timeout ? "订阅源抓取超时（15s）" : "订阅源抓取失败，请确认地址可公开访问" };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: "订阅源返回了无跳转目标的重定向（已拒绝）" };
      let next: string;
      try {
        next = new URL(loc, target).toString();
      } catch {
        return { ok: false, error: "订阅源重定向地址无法解析（已拒绝）" };
      }
      if (!/^https?:\/\//i.test(next)) return { ok: false, error: "订阅源重定向到非 http(s) 地址（已拒绝）" };
      target = next;
      continue;
    }
    return { ok: true, res };
  }
  return { ok: false, error: `订阅源跳转次数过多（>${MAX_REDIRECTS} 次），已拒绝` };
}

async function uniqueSlug(
  pool: NonNullable<Awaited<ReturnType<typeof getPool>>>,
  base: string
): Promise<string> {
  let candidate = base;
  let i = 2;
  while (await slugTaken(pool, candidate)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "登录后才能使用迁移工具（文章导入到你自己的账号）" }, { status: 401 });
  }
  if (!dbEnabled()) {
    return NextResponse.json({ error: "迁移工具需要 MySQL（当前为演示模式，无法持久化导入）" }, { status: 503 });
  }
  const pool = await getPool();
  if (!pool) {
    return NextResponse.json({ error: "数据库暂不可用，请稍后再试" }, { status: 503 });
  }

  const ct = req.headers.get("content-type") || "";
  let items: ImportItem[] = [];
  let source = "";

  try {
    if (ct.includes("application/json")) {
      /* ---------- RSS 抓取 ---------- */
      const body = (await req.json()) as { url?: string };
      const url = String(body.url ?? "").trim();
      if (!/^https?:\/\/.+/i.test(url)) {
        return NextResponse.json({ error: "RSS 地址需以 http(s):// 开头" }, { status: 400 });
      }
      const blocked = await isBlockedHost(url);
      if (blocked) {
        return NextResponse.json({ error: blocked }, { status: 400 });
      }
      // v17.2：手动逐跳跟随重定向，每一跳都重新做私网/环回校验（见 fetchFeedSafely）
      const fetched = await fetchFeedSafely(url);
      if (!fetched.ok) {
        return NextResponse.json({ error: fetched.error }, { status: 400 });
      }
      const res = fetched.res;
      if (!res.ok) {
        return NextResponse.json({ error: `订阅源返回 ${res.status}，请确认地址可公开访问` }, { status: 400 });
      }
      const xml = await res.text();
      // 重定向后的真实落点：超长响应体一刀切，避免被增长型响应拖死
      if (xml.length > MAX_XML) {
        return NextResponse.json({ error: "订阅源过大（>2MB），请精简后再试" }, { status: 400 });
      }
      items = parseFeed(xml);
      source = "rss";
      if (!items.length) {
        return NextResponse.json({ error: "未在订阅源中解析出文章（支持 RSS 2.0 / Atom）" }, { status: 400 });
      }
    } else if (ct.includes("multipart/form-data")) {
      /* ---------- Markdown 文件 ---------- */
      const form = await req.formData();
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (!files.length) {
        return NextResponse.json({ error: "未收到 .md 文件" }, { status: 400 });
      }
      if (files.length > MAX_ITEMS) {
        return NextResponse.json({ error: `一次最多导入 ${MAX_ITEMS} 个文件` }, { status: 400 });
      }
      for (const f of files) {
        if (!/\.(md|markdown|txt)$/i.test(f.name)) {
          items.push({ title: `__SKIP__${f.name}`, md: "", summary: "", publishedAt: null });
          continue;
        }
        if (f.size > MAX_MD_FILE) {
          items.push({ title: `__SKIP__${f.name}`, md: "", summary: "", publishedAt: null });
          continue;
        }
        items.push(parseMarkdownFile(await f.text(), f.name));
      }
      source = "markdown";
    } else {
      return NextResponse.json({ error: "Content-Type 须为 application/json（RSS）或 multipart/form-data（Markdown）" }, { status: 400 });
    }
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? "订阅源抓取超时（15s）" : "抓取/解析失败，请检查内容格式";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  /* ---------- 入库（去重 + slug 唯一化） ---------- */
  const imported: { title: string; slug: string }[] = [];
  const skipped: { title: string; reason: string }[] = [];
  let seq = 1;

  for (const it of items) {
    if (it.title.startsWith("__SKIP__")) {
      skipped.push({ title: it.title.slice(8), reason: "仅支持 .md/.markdown/.txt 且单文件 ≤300KB" });
      continue;
    }
    const title = it.title.trim();
    if (!title || !it.md.trim()) {
      skipped.push({ title: title || "(无标题)", reason: "标题或正文为空" });
      continue;
    }
    try {
      const [dupe] = await pool.query(
        "SELECT id FROM articles WHERE author_id = ? AND title = ? LIMIT 1",
        [user.id, title]
      );
      if (Array.isArray(dupe) && dupe.length > 0) {
        skipped.push({ title, reason: "你的账号下已有同名文章" });
        continue;
      }
      // v17.9：slug 撞唯一键（并发导入同名文章）时换号重试，不再直接判为「入库失败」
      let slug = "";
      let saved = false;
      for (let attempt = 0; attempt < 6 && !saved; attempt++) {
        slug = await uniqueSlug(pool, makeSlug(title, seq));
        try {
          await pool.query(
            `INSERT INTO articles
               (author_id, slug, title, md_content, summary, cover_label, tags, status, review_status,
                read_count, comment_count, agent_qa_count, published_at)
             VALUES (?, ?, ?, ?, ?, '迁移', ?, 'published', 'pending', 0, 0, 0, ?)`,
            [
              user.id,
              slug,
              title,
              it.md,
              it.summary,
              JSON.stringify(["迁移"]),
              // v17.1：源条目无日期（Markdown 文件、缺 pubDate 的 RSS）时落 NULL 会让
              // published_at 为空，进而让 sitemap/热榜等按日期计算的下游出错；统一取导入时间兜底
              it.publishedAt ?? new Date(),
            ]
          );
          saved = true;
        } catch (e) {
          if ((e as { code?: string }).code === "ER_DUP_ENTRY" && attempt < 5) {
            await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20) * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      imported.push({ title, slug });
      seq++;
    } catch {
      skipped.push({ title, reason: "入库失败（数据库异常）" });
    }
  }

  return NextResponse.json({
    source,
    imported: imported.length,
    articles: imported,
    skipped,
  });
}
