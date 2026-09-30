// 摘要计数器的**唯一一份**定义：复算式、豁免登记表，以及拿两者算漂移的函数。
// 这是一份被 import 的库，不是闸门也不是运维脚本——它自己什么都不判、什么都不修。
//
// 为什么单独立一个文件：闸门 21（`scripts/counter-check.mjs`）负责**判**，
// `scripts/recounters.mjs` 负责**修**。两边各抄一遍复算式，迟早会走成"修的人按 A 口径、
// 判的人按 B 口径"——而那正是这一族缺陷本身的成因：一列被很多地方读，却只该有一处在写它。
//
// 四条口径（要改先回来看这段，改这里就等于同时改了判据和对齐工具）：
//   · `read_count`     == `SUM(read_history.read_times)` —— 登录读者每打开一次 +1，游客不计
//   · `comment_count`  == `COUNT(comments)`              —— 楼中楼也算一条，删除按实际行数扣回
//   · `like_count`     == `COUNT(article_likes)`         —— 一人一行，取消即减
//   · `agent_qa_count` == `COUNT(agent_qa)`              —— P8a 起按 slug 归属，认领到才 +1
//
// ⚠ 这里的 SQL 全部用**不带库名前缀**的表名，跟着连接串的默认库走。
// 想量另一个库（比如主库 `inkstack`），换一条指过去那个库的连接，而不是在这里拼库名——
// 拼在 SQL 里的库名会在人没注意的时候把写操作带到别的库上。
/* ==================== 四列的复算式（一行一处，改口径只能改这里） ==================== */

export const COLUMNS = [
  { col: "read_count", real: (id) => ["SELECT IFNULL(SUM(read_times),0) AS n FROM read_history WHERE article_id = ?", [id]],
    why: "登录读者每打开一次 +1，与 SUM(read_times) 同涨" },
  { col: "comment_count", real: (id) => ["SELECT COUNT(*) AS n FROM comments WHERE article_id = ?", [id]],
    why: "发一条评论 +1（楼中楼也算一条），删多少行扣多少" },
  { col: "like_count", real: (id) => ["SELECT COUNT(*) AS n FROM article_likes WHERE article_id = ?", [id]],
    why: "点赞一人一行，取消即减" },
  { col: "agent_qa_count", real: (id) => ["SELECT COUNT(*) AS n FROM agent_qa WHERE article_id = ?", [id]],
    why: "P8a 起问答按 slug 归属，认领到才 +1" },
];

/**
 * 豁免登记表：换栈之前就坏在库里的那些（种子写的展示值 / 种子直接 INSERT 的演示行）。
 * 后两个数字是**登记当时**的 stored 与 real，只给人看来历，不参与比对；比对认的是名字。
 * 规则是双向棘轮：登记表外的新不一致 → 红；登记过但已经不差的 → 也红（该摘掉）。
 */
export const EXEMPT = [
  ["shou-xie-promise", "read_count", 12840, 3],
  ["shou-xie-promise", "comment_count", 135, 2],
  ["shou-xie-promise", "agent_qa_count", 1284, 0],
  ["wenfeng-dangan", "read_count", 4200, 0],
  ["wenfeng-dangan", "comment_count", 90, 3],
  ["wenfeng-dangan", "agent_qa_count", 302, 0],
  ["pgvector-gou-yong", "read_count", 3800, 13],
  ["pgvector-gou-yong", "comment_count", 65, 1],
  ["pgvector-gou-yong", "agent_qa_count", 96, 0],
  ["cong-ling-kai-shi-xie-zuo", "read_count", 1047, 0],
  ["cong-ling-kai-shi-xie-zuo", "like_count", 35, 0],
  ["cong-ling-kai-shi-xie-zuo", "agent_qa_count", 1, 0],
  ["shen-ye-shu-dian", "read_count", 1015, 1],
  ["shen-ye-shu-dian", "like_count", 55, 0],
  ["shen-ye-shu-dian", "agent_qa_count", 6, 0],
  ["ai-fen-shen-she-ji-si-lu", "read_count", 3495, 0],
  ["ai-fen-shen-she-ji-si-lu", "like_count", 49, 0],
  ["ai-fen-shen-she-ji-si-lu", "agent_qa_count", 17, 0],
  ["man-pao-yu-xie-zuo", "read_count", 1360, 1],
  ["man-pao-yu-xie-zuo", "like_count", 54, 0],
  ["man-pao-yu-xie-zuo", "agent_qa_count", 4, 0],
  ["mysql-man-cha-xun-pai-cha-shi-ji", "read_count", 970, 0],
  ["mysql-man-cha-xun-pai-cha-shi-ji", "like_count", 19, 0],
  ["mysql-man-cha-xun-pai-cha-shi-ji", "agent_qa_count", 15, 0],
  ["cheng-shi-man-bu-bi-ji", "read_count", 2283, 0],
  ["cheng-shi-man-bu-bi-ji", "like_count", 64, 0],
  ["cheng-shi-man-bu-bi-ji", "agent_qa_count", 1, 0],
  ["qian-duan-xing-neng-you-hua-qing-dan", "read_count", 1599, 1],
  ["qian-duan-xing-neng-you-hua-qing-dan", "like_count", 54, 0],
  ["qian-duan-xing-neng-you-hua-qing-dan", "agent_qa_count", 6, 0],
  ["rag-yin-yong-lu-bi-zhun-que-lu", "read_count", 3686, 0],
  ["rag-yin-yong-lu-bi-zhun-que-lu", "like_count", 62, 0],
  ["rag-yin-yong-lu-bi-zhun-que-lu", "agent_qa_count", 11, 0],
  ["wo-de-ge-ren-zhi-shi-ku", "read_count", 1510, 0],
  ["wo-de-ge-ren-zhi-shi-ku", "like_count", 32, 0],
  ["wo-de-ge-ren-zhi-shi-ku", "agent_qa_count", 8, 0],
  ["du-li-kai-fa-zhe-zhi-fu-ji-hua", "read_count", 2796, 0],
  ["du-li-kai-fa-zhe-zhi-fu-ji-hua", "like_count", 49, 0],
  ["yu-fa-bao-han-shi-ru-he-du-shu", "read_count", 2993, 0],
  ["yu-fa-bao-han-shi-ru-he-du-shu", "like_count", 63, 0],
  ["yu-fa-bao-han-shi-ru-he-du-shu", "agent_qa_count", 4, 0],
  ["xie-zuo-de-yi-shi-gan", "read_count", 1907, 0],
  ["xie-zuo-de-yi-shi-gan", "like_count", 21, 0],
  ["xie-zuo-de-yi-shi-gan", "agent_qa_count", 11, 0],
  ["nei-rong-chuang-zuo-ai-shi-yong-shou-ce", "read_count", 2049, 6],
  ["nei-rong-chuang-zuo-ai-shi-yong-shou-ce", "like_count", 44, 0],
  ["nei-rong-chuang-zuo-ai-shi-yong-shou-ce", "agent_qa_count", 11, 0],
  ["ye-jian-mo-shi-she-ji-ru-kao-cha", "read_count", 532, 0],
  ["ye-jian-mo-shi-she-ji-ru-kao-cha", "like_count", 53, 0],
  ["ye-jian-mo-shi-she-ji-ru-kao-cha", "agent_qa_count", 4, 0],
  ["bo-20260911-1", "read_count", 0, 12],
  ["bo-20260911-1", "comment_count", 0, 4],
  ["bo-20260914-2", "read_count", 0, 1],
];

export const exemptKey = (slug, col) => `${slug}|${col}`;
const EXEMPT_SET = new Set(EXEMPT.map(([slug, col]) => exemptKey(slug, col)));
/** 这一处漂移是不是登记过的种子/历史数据。 */
export const isExempt = (slug, col) => EXEMPT_SET.has(exemptKey(slug, col));

/**
 * 逐列复算当前库，返回所有**不一致**的行。
 * 一次取全部文章再逐列比：文章数量级是几十到几千，不值得为它写一句四段子查询的巨型 SQL——
 * 那种句子一旦要改口径，四处 `SELECT` 就会各自漂一点（运营台那条 UNION 排序规则的事故同形）。
 */
export async function measureDrift(conn) {
  const [all] = await conn.query(
    `SELECT id, slug, ${COLUMNS.map((c) => c.col).join(", ")} FROM articles ORDER BY id`);
  const drift = [];
  for (const a of all) {
    for (const spec of COLUMNS) {
      const [sql, params] = spec.real(a.id);
      const [rs] = await conn.query(sql, params);
      const real = Number(Object.values(rs[0])[0]);
      const stored = Number(a[spec.col]);
      if (stored !== real) drift.push({ slug: a.slug, id: a.id, col: spec.col, stored, real });
    }
  }
  return { articles: all.length, drift };
}

/** 按列汇总漂移条数，给报表用（`{read_count: 19, …}`）。 */
export function byColumn(drift) {
  const out = {};
  for (const d of drift) out[d.col] = (out[d.col] || 0) + 1;
  for (const spec of COLUMNS) if (!(spec.col in out)) out[spec.col] = 0;
  return out;
}

/** 渲染成 EXEMPT 那张表的字面量文本——对齐之后用它更新豁免表，不靠手抄。 */
export function registryText(drift) {
  return drift.map((d) => `  ["${d.slug}", "${d.col}", ${d.stored}, ${d.real}],`).join("\n");
}

/** 把连接串的默认库换成 `db`，其余部分原样（只读量另一个库时用得上）。 */
export function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
