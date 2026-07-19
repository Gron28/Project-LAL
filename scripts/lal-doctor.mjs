#!/usr/bin/env node
// Writes only redacted host capability facts. This bootstrap boundary is the
// sole reader of platform directories/environment for this diagnostic flow.
import path from "node:path";
import { resolvePlatformDirectories, collectRedactedHostFacts, writeRedactedDiagnostic } from "../web/src/lib/host-profile.ts";
function outputPath(argv) {
  const index = argv.indexOf("--output");
  if (index === -1) return path.join(resolvePlatformDirectories().state, "diagnostics", "host-facts.json");
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a file path");
  return path.resolve(value);
}
if (process.argv.includes("--help")) { process.stdout.write("Usage: node --experimental-strip-types scripts/lal-doctor.mjs [--output <file>]\n"); process.exit(0); }
const output = outputPath(process.argv.slice(2));
writeRedactedDiagnostic(output, collectRedactedHostFacts());
process.stdout.write(`wrote redacted host facts: ${output}\n`);
