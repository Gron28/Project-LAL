#!/usr/bin/env node
// Guard the physical Project-LAL protocol boundary. Both applications must import the
// same package; generated source mirrors are intentionally forbidden.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  package: "packages/protocol/src/index.ts",
  webFacade: "web/src/lib/protocol/index.ts",
  webRuns: "web/src/lib/runs.ts",
  webStream: "web/src/app/api/agent/runs/[id]/stream/route.ts",
  cliBridge: "apps/cli/packages/core/src/lal/protocol.ts",
};

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`missing ${relativePath}`);
  return fs.readFileSync(absolutePath, "utf8");
}

function requireText(name, text, expected) {
  if (!text.includes(expected)) throw new Error(`${files[name]} must contain ${JSON.stringify(expected)}`);
}

try {
  const source = read(files.package);
  requireText("package", source, "export const PROTOCOL_VERSION");
  requireText("package", source, "export const KNOWN_EVENT_KINDS");
  requireText("package", source, "export function isKnownEventKind");

  for (const name of ["webFacade", "webRuns", "webStream", "cliBridge"]) {
    const text = read(files[name]);
    requireText(name, text, "@project-lal/protocol");
    if (text.includes("GENERATED / MIRRORED FILE")) {
      throw new Error(`${files[name]} still contains a generated protocol mirror`);
    }
  }

  console.log("shared protocol boundary OK — web and CLI consume @project-lal/protocol");
} catch (error) {
  console.error(`protocol boundary check failed: ${(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
}
