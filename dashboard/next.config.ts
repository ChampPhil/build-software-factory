import type { NextConfig } from "next";

/**
 * A static export. The dashboard has no backend by design: the browser talks
 * to GitHub directly with the user's own token, so no data passes through any
 * server the maintainer runs.
 */
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // Which build this is, shown in the footer so a person can tell a stale deploy from a current one.
  env: { NEXT_PUBLIC_BUILD_SHA: process.env["NEXT_PUBLIC_BUILD_SHA"] ?? process.env["GITHUB_SHA"] ?? process.env["VERCEL_GIT_COMMIT_SHA"] ?? "dev" },
};

export default config;
