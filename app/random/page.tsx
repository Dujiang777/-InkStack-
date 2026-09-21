// /random — 漫游记：随机跳到一篇已过审的公开文章（解乏彩蛋）
// v15.0：由 API 路由改为服务端页面。原 302 用 req.url 拼绝对地址，
// 生产模式 host 会落 localhost，与页面 origin 不同源触发 CSP 拦截；
// redirect() 由客户端按当前 origin 解析，预取/直跳都安全，且 RSC 预取可用。
// 支持 ?exclude=slug 避免连续抽到同一篇
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function RandomPage({
  searchParams,
}: {
  searchParams: Promise<{ exclude?: string }>;
}) {
  const { exclude = "" } = await searchParams;
  const pool = await getPool();
  let target = "/";
  if (pool) {
    try {
      const [rows] = await pool.query(
        `SELECT slug FROM articles
         WHERE status = 'published' AND review_status = 'approved' AND slug != ?
         ORDER BY RAND() LIMIT 1`,
        [exclude.trim()]
      );
      const slug = (rows as { slug?: string }[])[0]?.slug;
      if (slug) target = `/article/${slug}`;
    } catch {
      /* 落到兜底 */
    }
  }
  redirect(target);
}
