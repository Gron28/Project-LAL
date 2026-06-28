import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local tool: don't let strict types block running the copied assistant UI.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
