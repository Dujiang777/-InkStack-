// 认证层里**渲染层还在用**的那一小截：角色判定 + 两个会话数据的类型。
//
// P7f-2 之前这是一整套：scrypt 密码哈希、HMAC 会话签发与校验、sessions 表双保险、设备列表、
// 按令牌吊销……它服务的是 `app/api/**` 那 44 条遗留路由（最后一批用到它的页面在 P7f-1f-b 改问
// Java）。路由删掉之后那些实现整体退场——身份判定归 Java 的 `SessionService.resolve`，
// 设备列表归 `GET /api/security/sessions`，页面经 `lib/java-source.ts` 问它们。
// 留下来的只有下面这些**没有任何 I/O** 的共用片段。
//
// 为什么 `isStaff` 还留在 Next 侧、不也去问一次：它是纯函数，渲染期只用来决定"运营台"这个
// 标签亮不亮。判定权在 Java——每个 `/api/admin/*` 进方法第一件事就是 staffOnly，那一道门禁
// 由闸门 19 逐个端点钉着；这里只是同一条规则的展示镜像，一旦分叉，表现是
// "给非运营人员亮出一个点进去 403 的入口"。
//
// 会话表与审计表由 `db/schema.sql` 建（P7c 起 Node 侧不再懒建表）。

export type SessionUser = {
  id: number;
  nickname: string;
  email: string;
  role: string;
  points: number;
};

/** 设备列表的一行。键名沿用 Node 时代的 snake_case——组件类型与 Java 的应答都是这套写法。 */
export type SessionRow = {
  id: number;
  ua: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
};

/** 角色体系（v17.1）：developer > admin > author > user。运营侧 = admin 与 developer。 */
export function isStaff(role: string | undefined | null): boolean {
  return role === "admin" || role === "developer";
}
