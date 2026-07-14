import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Permit an isolated recovery/dev instance to use the same source tree
  // without contending for the primary .next lock. Both instances still share
  // the durable .data directory, so workflow state survives a broken hot reload.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Local tool: don't let strict types block running the copied assistant UI.
  typescript: { ignoreBuildErrors: true },
  // ast-cache.ts loads a wasm grammar via a computed require.resolve() path — webpack's
  // static analysis follows that into the WHOLE tree-sitter-wasms/out/ directory
  // (dozens of grammars we never use), and several of their .loader.mjs companions
  // import from wasm-loader-specific pseudo-modules ("env", "WASM_PATH") no bundler
  // config here understands, breaking the build. These are server-only, Node-native
  // wasm loaders — opt them out of bundling entirely and let native `require` handle
  // them at runtime instead.
  serverExternalPackages: ["web-tree-sitter", "tree-sitter-wasms"],
};

export default nextConfig;
