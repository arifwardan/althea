/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  transpilePackages: ["@althea/shared", "@althea/types", "@althea/ui"],
};

export default nextConfig;
