import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ["mac-pro", "172.17.0.1"],
  output: "export",
  trailingSlash: true,
};
export default nextConfig;
