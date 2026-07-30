import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOwnerBackup, restoreOwnerBackup } from "./backup-owner-data.mjs";

test("owner backup restores representative data and excludes model weights", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-backup-test-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "web", ".data"), { recursive: true });
  fs.mkdirSync(path.join(repo, "models"), { recursive: true });
  fs.writeFileSync(path.join(repo, "web", ".data", "hive.db"), "representative");
  fs.writeFileSync(path.join(repo, "models", "manifest.json"), "{}");
  fs.writeFileSync(path.join(repo, "models", "large.gguf"), "weight");
  const backup = createOwnerBackup(path.join(root, "backups"), repo);
  const restored = restoreOwnerBackup(backup.root, path.join(root, "restore"));
  assert.equal(restored.files, 2);
  assert.equal(fs.readFileSync(path.join(restored.target, "web", ".data", "hive.db"), "utf8"), "representative");
  assert.equal(fs.existsSync(path.join(restored.target, "models", "large.gguf")), false);
  fs.rmSync(root, { recursive: true, force: true });
});
