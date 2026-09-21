/** @type {import('next').NextConfig} */
const nextConfig = {
  // 双轨验证需要两个 dev 实例并存（一个取数走 Node、一个走 Java），
  // 共用 .next 会互相冲掉 manifest，故第二个实例用独立 distDir。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 个人开发版：关闭严格类型检查引起的构建阻塞，保证快速迭代
  typescript: { ignoreBuildErrors: false },
  // 安全：不向响应暴露框架指纹（v13.5）
  poweredByHeader: false,
};

export default nextConfig;
