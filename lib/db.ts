// 数据库连接层：配置了 DATABASE_URL 才创建连接池；否则所有查询走演示数据降级
//
// ⚠️ 池必须挂在 globalThis 上：Next dev 每次热重载都会重新实例化本模块，
// 若只存模块级变量，每次编译都会新建一个 8 连接池，几十次重编译就能把
// MySQL 的连接数（默认 151）耗光（实测单进程握 152 条 → Too many connections）。
import type { Pool } from "mysql2/promise";

const g = globalThis as unknown as { __inkPool?: Pool };

export async function getPool(): Promise<Pool | null> {
  if (!process.env.DATABASE_URL) return null;
  if (!g.__inkPool) {
    // 动态引入：未安装依赖/未配置时不会阻塞页面渲染
    const mysql = await import("mysql2/promise");
    g.__inkPool = mysql.createPool({
      uri: process.env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 8,
      // 空闲连接回收，防长时间驻留占用服务端配额
      maxIdle: 4,
      idleTimeout: 60_000,
    });
  }
  return g.__inkPool;
}

export function dbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
