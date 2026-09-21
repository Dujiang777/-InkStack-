/** @type {import('next').NextConfig} */
const nextConfig = {
  // 个人开发版：关闭严格类型检查引起的构建阻塞，保证快速迭代
  typescript: { ignoreBuildErrors: false },
  // 安全：不向响应暴露框架指纹（v13.5）
  poweredByHeader: false,
};

export default nextConfig;
