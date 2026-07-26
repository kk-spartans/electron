import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ["mac-pro", "172.17.0.1"],
  output: "export",
  // GitHub Pages serves CI builds from https://kk-spartans.github.io/electron.
  basePath: process.env.GITHUB_ACTIONS === "true" ? "/electron" : "",
  trailingSlash: true,
};
export default nextConfig;
