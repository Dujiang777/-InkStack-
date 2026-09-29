#!/usr/bin/env node
// 契约基线：把"旧实现应答长什么样"固化成仓库里的文件。
//
// 为什么要有这一道（P7f-1b）：闸门 1 的 parity 是**差分**闸门——它证明的是"Java 与 Node 一样"。
// P7f-2 真的把 58 个 app/api 路由删了之后对岸就没有了，parity 随之退役（gate-executor 那套
// "两侧同一个执行者就别起跑"从此恒成立）。那之后 Java 的读侧契约就再没人守：改一个字段名、
// 少返回一个键、把 null 变成空串，都不会有任何闸门响。这一道补的就是那一格，它是那一道接班人。
//
//   node scripts/contract.mjs check               拿 PARITY_JAVA 逐条重放
//   …… --base=http://host:port                    指定站点
//   …… --only=id1,id2                             只做这几条
//   …… --list                                     只列用例表
//   （freeze 已停用，理由见下面那个函数）
//
// 比的是**形状**为主、值只钉恒定的那几条，这一点必须说清楚，否则会误用：
//   · 形状（键集 / 类型 / 可空性 / 数组元素形状 / 嵌套层级）是契约里会被人改坏的那一半，
//     而且它不随库里有什么而变——所以基线能长期放在仓库里。
//   · 值会随时间变（重力排序的先后、views、相对时间、加热还在不在有效期），把值录进基线
//     等于造一盏每天早晨都红的灯。值的正确性不归这里，归闸门 3/4/7/9/12——那些是**回库重算**
//     再比对的，本来就比"同一个上星期的快照自己跟自己比"强。
//   · 例外：确实恒定的值用 expect 钉住（套餐表的四档、providers 的三个布尔）。
//     这几条是逐条确认过"不随数据变"的，不是顺手抄下来的应答。
//
// 出处是这道闸门的命门：每条基线文件里都记着 `frozenFromExecutor`。这 30 条记的是 "node"，
// 所以它们的意思是"Java 必须符合旧实现的形状"。哪天出现一份记着 "java" 的基线，它的意思就退化成
// "Java 必须符合 Java 上次的样子"——自我回归，仍然能抓住重构手滑，但**不再是换栈正确的证据**。
// 所以别去重新生成它们；check 也会把 frozenFromExecutor 印在表头上，让这件事看得见。
import fs from "node:fs";
import path from "node:path";
import { executorOf } from "./gate-executor.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "contract");
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const argv = process.argv.slice(2);
const verb = argv[0];
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ONLY = argOf("only", "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * 用例表。as 决定用哪个身份登录，凭据只从本地 .env 取——写进命令行就会留在 shell 历史里。
 *
 * optional 列的是"同一个 URL 在别的时刻/别的身份下会整个缺席"的键（如加热过期的 boostUntil）。
 * 它只放宽"缺键"这一种差异，多出来的键、类型变了照样红——所以列错一个就少守一条，
 * 别顺手把不确定的都塞进来。
 *
 * expect 钉恒定值，路径支持 a.b[0].c 与 a.b.length。
 */
const CASES = [
  { id: "articles-list", path: "/api/articles", as: "guest",
    optional: ["articles.[*].boostUntil"] },
  { id: "articles-list-member", path: "/api/articles", as: "test" },
  { id: "article-free", path: "/api/articles/shou-xie-promise", as: "guest",
    // 免费文的 viewerUnlocked 是 **false** 而不是 true：这个字段说的是"有没有解锁记录"，
    // 不是"能不能读"。前端判付费墙靠 unlockPrice>0 && !viewerUnlocked，两栈同口径。
    // 这里钉住 0 就够，别顺手把 viewerUnlocked 也钉成 true——那是想象中的语义。
    expect: { "article.unlockPrice": 0 } },
  { id: "article-paid-guest", path: "/api/articles/bo-20260911-1", as: "guest",
    // 这四条是这道闸门里唯一"钉值"的地方，也是它最该钉的地方：付费墙失效在形状上
    // 完全看不出来（viewerUnlocked 是 bool→bool、md 是 string→string）。
    // 11 行是这份夹具付费文的总行数、6 行是 SQL 的预览切点——改了夹具正文要重新 freeze，
    // 但**别把它改成宽容比较**：截断发生在 SQL 层正是这条链路的防线所在（闸门 3 同源）。
    expect: { "article.unlockPrice": 40, "article.viewerUnlocked": false,
      "article.md#lines": 6, "article.md#chars": 119 } },
  { id: "article-paid-author", path: "/api/articles/bo-20260911-1", as: "writer",
    expect: { "article.viewerUnlocked": true, "article.md#lines": 11 } },
  { id: "article-paid-member", path: "/api/articles/bo-20260911-1", as: "probe",
    expect: { "article.viewerUnlocked": false, "article.md#lines": 6 } },
  { id: "article-missing", path: "/api/articles/bu-cun-zai-de-slug", as: "guest" },
  { id: "search-guest", path: "/api/search?q=promise", as: "guest" },
  { id: "search-member", path: "/api/search?q=then", as: "test" },
  { id: "comments", path: "/api/articles/shou-xie-promise/comments", as: "guest" },
  { id: "notifications-anon", path: "/api/notifications", as: "guest" },
  { id: "notifications", path: "/api/notifications", as: "test" },
  { id: "checkin", path: "/api/checkin", as: "writer" },
  { id: "me-overview", path: "/api/me/overview", as: "writer" },
  { id: "auth-me-anon", path: "/api/auth/me", as: "guest",
    expect: { user: null } },
  { id: "auth-me", path: "/api/auth/me", as: "test" },
  { id: "auth-providers", path: "/api/auth/providers", as: "guest",
    expect: { ok: true, github: false, gitee: true, qq: false } },
  { id: "github-status", path: "/api/auth/github/status", as: "guest" },
  { id: "topup-packs", path: "/api/topup/orders", as: "guest",
    // 四档套餐是两栈各自硬编码的常量（lib/data-legacy 与 TopupService.PACKS），
    // 不随库里有什么变，所以这几条钉的是真契约而不是偶然取样。
    expect: {
      "packs.length": 4,
      "packs[0].key": "starter", "packs[1].key": "standard",
      "packs[2].key": "pro", "packs[3].key": "studio",
      "packs[2].points": 6500, "packs[2].cents": 5000,
    } },
  { id: "series-shelf", path: "/api/series?limit=6", as: "guest" },
  { id: "series-mine-anon", path: "/api/series/mine", as: "guest" },
  { id: "series-mine", path: "/api/series/mine", as: "writer" },
  { id: "series-landing", path: "/api/series/999999", as: "guest" },
  { id: "drafts-anon", path: "/api/drafts?title=x", as: "guest" },
  { id: "drafts", path: "/api/drafts?title=x", as: "writer" },
  { id: "links-queue", path: "/api/links?status=pending", as: "test" },
  { id: "sessions", path: "/api/security/sessions", as: "test" },
  { id: "agent-status", path: "/api/agent/status", as: "guest" },
  { id: "raw-anon", path: "/api/articles/bo-20260911-1/raw", as: "guest" },
  { id: "export-md", path: "/api/articles/shou-xie-promise/export", as: "writer" },
];

const CRED = {
  test: ["INK_TEST_EMAIL", "INK_TEST_PASSWORD"],
  writer: ["INK_WRITER_EMAIL", "INK_WRITER_PASSWORD"],
  probe: ["INK_PROBE_EMAIL", "INK_PROBE_PASSWORD"],
};
const cookies = new Map();

async function cookieOf(base, who) {
  if (who === "guest") return null;
  const ck = `${base}|${who}`;
  if (cookies.has(ck)) return cookies.get(ck);
  const pair = CRED[who];
  if (!pair) throw new Error(`未知身份 ${who}`);
  if (!env[pair[0]] || !env[pair[1]]) throw new Error(`.env 缺少 ${who} 的凭据`);
  const res = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env[pair[0]], password: env[pair[1]] }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new Error(`在 ${base} 以 ${env[pair[0]]} 登录失败：${JSON.stringify(body).slice(0, 120)}`);
  const session = (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ink_session="));
  if (!session) throw new Error(`${base} 登录成功但没有 ink_session`);
  cookies.set(ck, session);
  return session;
}

async function fetchCase(base, c) {
  const cookie = await cookieOf(base, c.as);
  const res = await fetch(base + c.path, {
    headers: { ...(cookie ? { cookie } : {}), "user-agent": "inkstack-contract" },
    cache: "no-store", redirect: "manual",
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

/* ————————————————————— 形状 ————————————————————— */

/**
 * 值 → 形状。标量只记类型；对象记"每个键 + 该键的形状 + 是否必需"；数组记长度与
 * **合并后的元素形状**——列表元素本就常常带不齐同一套键，合并才不会把一次取样里的偶然
 * 当成契约（合并规则见 mergeShapes）。
 */
function shapeOf(v) {
  if (v === null) return { t: "null" };
  if (Array.isArray(v)) {
    const items = v.map(shapeOf);
    return { t: "array", n: v.length, item: items.length ? mergeShapes(items) : null };
  }
  if (typeof v === "object") {
    const props = {};
    for (const k of Object.keys(v)) props[k] = { req: true, s: shapeOf(v[k]) };
    return { t: "object", props };
  }
  return { t: typeof v };
}

/** 一个形状允许哪些类型。any 不是叶子类型，展开它，否则二次合并会把已有的分支弄丢。 */
const typesOf = (s) => (s.t === "any" ? s.of : [s.t]);

/**
 * 同类合并；不同类就退化成"允许这几个类型"（判据放宽一条，好过把闸门做成随机的）。
 *
 * 这里必须**递归**合并，不能"取第一个样本的形状、只把键标成可选"——那样一条列表里
 * 第一篇恰好 tags:[] / discountUntil:null 时，后面二十三篇的形状会被第一篇盖掉，
 * 基线于是把"tags 一定是空数组"当成契约，第二天就自己红给自己看。
 */
function mergeShapes(list) {
  const first = list[0];
  if (list.every((s) => JSON.stringify(s) === JSON.stringify(first))) return first;
  if (first.t === "object" && list.every((s) => s.t === "object")) {
    const props = {};
    for (const s of list) {
      for (const k of Object.keys(s.props)) {
        if (!(k in props)) props[k] = { req: true, s: s.props[k].s };
        else props[k] = { req: false, s: mergeShapes([props[k].s, s.props[k].s]) };
      }
    }
    return { t: "object", props };
  }
  if (first.t === "array" && list.every((s) => s.t === "array")) {
    const items = list.map((s) => s.item).filter(Boolean);
    return { t: "array", n: Math.max(...list.map((s) => s.n)), item: items.length ? mergeShapes(items) : null };
  }
  return { t: "any", of: [...new Set(list.flatMap(typesOf))].sort() };
}

const trailOf = (trail, k) => (trail ? `${trail}.${k}` : k);

/* ————————————————————— 比形状 ————————————————————— */

function typeOf(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function cmpShape(shape, live, trail, waived, out) {
  if (shape.t === "any") {
    if (!shape.of.includes(typeOf(live))) {
      out.push(`${trail || "(根)"}: 类型 ${typeOf(live)} 不在基线允许的 ${shape.of.join("|")} 里`);
    }
    return;
  }
  if (typeOf(live) !== shape.t) {
    out.push(`${trail || "(根)"}: 类型 基线=${shape.t} 现在=${typeOf(live)}（值 ${JSON.stringify(live)?.slice(0, 60)}）`);
    return;
  }
  if (shape.t === "object") {
    for (const k of Object.keys(shape.props)) {
      const p = shape.props[k];
      const trail2 = trailOf(trail, k);
      if (!(k in live)) {
        if (!p.req || waived.has(trail2)) continue;
        out.push(`${trail2}: 基线里有这个键，现在没有`
          + (p.s.t === "null" ? "（基线取样时它的值是 null——「没有这个键」与「值是 null」是两件事）" : ""));
        continue;
      }
      cmpShape(p.s, live[k], trail2, waived, out);
    }
    for (const k of Object.keys(live)) {
      if (!(k in shape.props)) {
        out.push(`${trailOf(trail, k)}: 现在多出这个键（基线里没有）= ${JSON.stringify(live[k])?.slice(0, 60)}`);
      }
    }
    return;
  }
  if (shape.t === "array") {
    if (!shape.item) {
      if (live.length) {
        out.push(`${trail || "(根)"}: 基线里这个数组取样时**每一处都是空的**、现在有 ${live.length} 项`
          + "——元素形状无从校验，要么重新 freeze，要么把它列进 optional");
      }
      return;
    }
    // 顺序不逐项对齐：列表先后由数据算出来（重力 / 热度 / 时间），基线放几天就会自己换序。
    // 先后本身对不对归闸门 4（首页必须落在库算出的重力前 50 里）与闸门 7/9 管，这里只保证
    // **每一项**都长成基线那个形状。
    for (let i = 0; i < live.length; i++) cmpShape(shape.item, live[i], `${trail}.[*]`, waived, out);
  }
}

/**
 * 路径取值，支持 a.b、a.b[0].c、a.b.length，以及两个派生尾缀 a.b#lines / a.b#chars。
 *
 * 派生尾缀是给"截断本身就是契约"的字段用的：付费墙有没有生效，看的是正文被切到第几行，
 * 而行数既不是类型也不是键，纯形状比对看不见（viewerUnlocked 是 bool→bool、md 是
 * string→string，两种情况形状完全同形）。所以这里开一个能算的口子。
 */
function getPath(obj, dotted) {
  const derive = dotted.match(/^(.*?)#(lines|chars)$/);
  if (derive) {
    const v = getPath(obj, derive[1]);
    if (typeof v !== "string") return undefined;
    return derive[2] === "lines" ? v.split("\n").length : v.length;
  }
  const parts = String(dotted).replace(/\[(\d+|\*)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/* ————————————————————— 动词 ————————————————————— */

function fileFor(id) {
  return path.join(dir, `${id}.json`);
}

/**
 * freeze 这个动词在 P7f-2 之后**没有宾语了**：基线的价值全在"它是旧实现答出来的"，
 * 而 Node 那一侧已经不应答任何 /api 了。留着它只会让人以为还能补基线——从 Java 抄一份
 * "基线"回去，等于让被测方给自己的考卷打分。所以这里只留一句拒绝，并说清该怎么做。
 */
async function freeze() {
  console.error(
    "freeze 已经停用：app/api/** 在 P7f-2 删掉之后，再也采样不到「旧实现的应答」了。\n" +
    "  contract/ 里的 30 条基线是 Node 时代冻的历史，它们的作用到此是不可再生。\n" +
    "  要新增用例：照需求**手写**一个 contract/<id>.json（status + shape + 钉住的 expect 值），\n" +
    "  然后跑 `node scripts/contract.mjs check --only=<id>` 看 Java 答不答得对。\n" +
    "  别从当前实现里抄——那只能证明它和它自己一致。"
  );
  process.exit(1);
}

async function check() {
  const base = argOf("base", process.env.PARITY_JAVA || env.PARITY_JAVA || "http://localhost:3101");
  // --as 只有一种正当用法：故意换一个身份重放，看基线认不认得出来。基线是分身份冻结的，
  // 拿别人的身份去对同一条基线**必须**红——红不了就说明这条基线根本没锁住权限差异。
  const as = argOf("as", "");
  const who = await executorOf(base);
  console.log(`重放 ${base}（应答方 ${who}）${as ? `  ⚠ 身份被强制改成 ${as}，这是反证跑法，红了才对` : ""}\n`);
  let pass = 0;
  let fail = 0;
  let absent = 0;
  for (const c0 of CASES) {
    if (ONLY.length && !ONLY.includes(c0.id)) continue;
    const c = as ? { ...c0, as } : c0;
    const file = fileFor(c0.id);
    if (!fs.existsSync(file)) {
      console.log(`FAIL  ${c.id.padEnd(22)} — 没有基线文件；freeze 已停用，请照需求手写 contract/<id>.json`);
      absent++; fail++;
      continue;
    }
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    const waived = new Set(b.optional ?? []);
    const out = [];
    const r = await fetchCase(base, c);
    if (r.status !== b.status) out.push(`(status): 基线=${b.status} 现在=${r.status}`);
    if (b.shape.t === "text") {
      if (r.json !== undefined) out.push("(根): 基线是非 JSON 文本，现在却能 parse 成 JSON");
      else if (r.text.slice(0, 40) !== b.shape.sample.slice(0, 40)) {
        out.push(`(文本) 前 40 字就不同：${JSON.stringify(r.text.slice(0, 60))}`);
      }
    } else if (r.json === undefined) {
      out.push(`(根): 基线是 JSON，现在不是（${r.status} ${r.text.slice(0, 60)}）`);
    } else {
      cmpShape(b.shape, r.json, "", waived, out);
      for (const [dotted, want] of Object.entries(b.expect ?? {})) {
        const got = getPath(r.json, dotted);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          out.push(`${dotted}: 钉住的值 基线=${JSON.stringify(want)} 现在=${JSON.stringify(got)}`);
        }
      }
    }
    if (out.length) {
      fail++;
      console.log(`FAIL  ${c.id.padEnd(22)} [${r.status}] ${out.length} 处`);
      for (const d of out.slice(0, 10)) console.log(`        · ${d}`);
      if (out.length > 10) console.log(`        · …另有 ${out.length - 10} 处`);
    } else {
      pass++;
      console.log(`PASS  ${c.id.padEnd(22)} [${r.status}]`);
    }
  }
  // 基线的**出处**是这道闸门的命门：只有 Node 时代冻下来的才叫"旧实现的形状"。
  // 这一项不是装饰——freeze 停用之后，谁手工补一份"从 Java 抄来的基线"，这道闸门就会
  // 在还剩 29 条真基线的情况下把它一起算成绿。
  const from = {};
  for (const c of CASES) {
    if (!fs.existsSync(fileFor(c.id))) continue;
    const k = JSON.parse(fs.readFileSync(fileFor(c.id), "utf8")).frozenFromExecutor ?? "未记录";
    from[k] = (from[k] ?? 0) + 1;
  }
  const strays = Object.entries(from).filter(([k]) => k !== "node")
    .map(([k, n]) => `${k} ${n} 条`);
  if (!strays.length) {
    pass++;
    console.log(`PASS  ${Object.values(from).reduce((a, b) => a + b, 0)} 条基线全部冻自 Node 时代（出处可查）`);
  } else {
    fail++;
    console.log(`FAIL  有 ${strays.join("、")} 基线不是 Node 时代冻的`
      + "——那种基线只证明\"以后别自己变\"，不证明\"与旧实现同形\"");
  }
  console.log(`\n合计 ${pass + fail} 项（缺基线 ${absent}），失败 ${fail} 项`);
  console.log("注：这里守的是**形状 + 钉住的恒定值**。值随库里有什么而变，值的正确性由闸门 3/4/7/9/12"
    + "回库重算来管——那比「跟上周的快照自己跟自己比」强。");
  process.exit(fail ? 1 : 0);
}

if (verb === "freeze") await freeze();
else if (verb === "check") await check();
else if (verb === "--list" || argv.includes("--list")) {
  for (const c of CASES) console.log(`${c.id.padEnd(22)} ${c.as.padEnd(6)} GET ${c.path}`);
} else {
  console.error("用法：node scripts/contract.mjs check [--base=…] [--only=id1,id2|--list]（freeze 已停用）");
  process.exit(2);
}
