import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceGrantRepository } from "./workspace-grants.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-workspace-grants-"));
  const safe = path.join(root, "workspace");
  const allowed = path.join(root, "allowed");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(safe); fs.mkdirSync(allowed); fs.mkdirSync(sibling);
  return { root, safe, allowed, sibling, grants: path.join(root, "state", "workspace-grants.json") };
}

test("default workspace is available without an ambient broad grant", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const repository = new WorkspaceGrantRepository(f.grants, f.safe);
  assert.equal(repository.resolveGrantedDirectory(f.safe), f.safe);
  assert.equal(repository.resolveGrantedDirectory(f.sibling), null);
  assert.deepEqual(repository.list(), []);
});

test("a durable grant authorizes its descendants but not sibling directories", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const repository = new WorkspaceGrantRepository(f.grants, f.safe);
  assert.equal(repository.grant(f.allowed, new Date("2026-07-19T00:00:00.000Z"))?.path, f.allowed);
  fs.mkdirSync(path.join(f.allowed, "nested"));
  assert.equal(repository.resolveGrantedDirectory(path.join(f.allowed, "nested")), path.join(f.allowed, "nested"));
  assert.equal(repository.resolveGrantedDirectory(f.sibling), null);
  const restarted = new WorkspaceGrantRepository(f.grants, f.safe);
  assert.equal(restarted.resolveGrantedDirectory(f.allowed), f.allowed);
});

test("revocation is durable and blocks subsequent actions", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const repository = new WorkspaceGrantRepository(f.grants, f.safe);
  repository.grant(f.allowed);
  assert.equal(repository.resolveGrantedDirectory(f.allowed), f.allowed);
  assert.equal(repository.revoke(f.allowed), true);
  assert.equal(repository.resolveGrantedDirectory(f.allowed), null);
  assert.equal(new WorkspaceGrantRepository(f.grants, f.safe).resolveGrantedDirectory(f.allowed), null);
});
