import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStateMigrationDryRun } from "./state-migration.ts";

test("state migration dry run inventories copies, identical bytes, and conflicts without changing roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-migration-"));
  try {
    const source = path.join(root, "legacy"); const target = path.join(root, "external");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true }); fs.mkdirSync(path.join(target, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "copy.txt"), "copy"); fs.writeFileSync(path.join(source, "nested", "same.txt"), "same"); fs.writeFileSync(path.join(source, "conflict.txt"), "source");
    fs.writeFileSync(path.join(target, "nested", "same.txt"), "same"); fs.writeFileSync(path.join(target, "conflict.txt"), "target");
    const report = createStateMigrationDryRun({ sources: { data: source }, destinations: { data: target, state: path.join(root, "state"), cache: path.join(root, "cache") } });
    assert.equal(report.mode, "dry-run"); assert.equal(report.totals.copy, 1); assert.equal(report.totals["already-present"], 1); assert.equal(report.totals.conflict, 1); assert.equal(report.bytesToCopy, 4);
    assert.equal(fs.readFileSync(path.join(target, "conflict.txt"), "utf8"), "target");
    assert.equal(fs.existsSync(path.join(target, "copy.txt")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
