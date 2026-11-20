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
};

export default config;
