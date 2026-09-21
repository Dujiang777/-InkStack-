// 展示层文字净化：摘要字段历史上带了 RSS/HTML 片段（从周刊同步来的文章尤其明显），
// 直接输出会把 <p>、<a href="…"> 原样印在页面上，读者看到的是源码。
// 这里只做「去标签 + 解实体 + 收空白」，纯展示层处理，不改动任何数据与存储。
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

export function plainText(input?: string | null): string {
  if (!input) return "";
  let s = String(input);
  // RSS 残留的 CDATA 包裹先摘掉：只摘标签的话「]]>」会当正文留下来
  s = s.replace(/<!\[CDATA\[|\]\]>/g, " ");
  // 脚本 / 样式整段丢掉（含内容），再丢掉其余标签；用空格替标签，避免相邻单词粘连
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]*>/g, " ");
  // 数字实体与常见命名实体
  s = s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref.charAt(0) === "#") {
      const hex = ref.charAt(1) === "x" || ref.charAt(1) === "X";
      const code = Number.parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[ref.toLowerCase()] ?? m;
  });
  // markdown 残留：图片整个丢掉，链接只留文字
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 收尾：截断在标签中间时把尾巴清掉，再把连续空白收成一个空格
  s = s.replace(/<[^>]*$/, " ").replace(/[ \t\r\n]+/g, " ");
  return s.trim();
}

export default plainText;
