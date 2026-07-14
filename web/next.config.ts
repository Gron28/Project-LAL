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
  async headers() {
    // Next's static file server has no ".ps1" mime entry and falls back to
    // application/octet-stream. Windows PowerShell's Invoke-RestMethod treats an
    // unrecognized content type as a cue to attempt XML auto-parsing; the install
    // script text isn't XML, so IRM silently hands back a bare XmlDocument object
    // instead of the script text, and Invoke-Expression then tries to run that
    // object's ToString() ("System.Xml.XmlDocument") as a command. Forcing
    // text/plain here is what makes `irm .../install.ps1 | iex` and `lal update`
    // actually receive the script as a string.
    return [
      {
        source: "/lal/install.ps1",
        headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
      },
    ];
  },
};

export default nextConfig;
