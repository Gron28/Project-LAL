import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MediaArtifactRepository } from "./media-artifacts.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-media-artifacts-"));
  return { root, repository: new MediaArtifactRepository(path.join(root, "artifacts")) };
}
const access = { subject: "alice", capabilities: ["media.artifact.read"] };

test("data URL ingestion is local-only, content-addressed, and deduplicated", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const input = { source: { kind: "data-url" as const, value: "data:text/plain;base64,aGVsbG8=" }, ownerSubject: "alice", readGrants: ["subject:alice"] };
  const first = f.repository.ingest(input), second = f.repository.ingest(input);
  assert.match(first.id, /^media:sha256:[a-f0-9]{64}$/); assert.equal(first.id, second.id); assert.equal(first.kind, "other");
  assert.throws(() => f.repository.ingest({ ...input, source: { kind: "data-url", value: "https://example.test/never-fetch" } }), /base64 data/);
});

test("local source requires a canonical-path authorization decision", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const file = path.join(f.root, "clip.wav"); fs.writeFileSync(file, "sound-bytes");
  const input = { source: { kind: "local-file" as const, path: file }, ownerSubject: "alice", readGrants: ["subject:alice"] };
  assert.throws(() => f.repository.ingest(input), /not authorized/);
  const artifact = f.repository.ingest({ ...input, authorizeLocalPath: (candidate) => candidate === fs.realpathSync(file) });
  assert.equal(artifact.sourceKind, "local-file");
});

test("authorized reads verify stored bytes and always require attachment delivery", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const artifact = f.repository.ingest({ source: { kind: "data-url", value: "data:image/png;base64,aW1hZ2U=" }, ownerSubject: "alice", readGrants: ["subject:alice"] });
  assert.equal(f.repository.readAuthorized(artifact.id, { subject: "mallory", capabilities: ["media.artifact.read"] }), null);
  const allowed = f.repository.readAuthorized(artifact.id, access); assert.equal(allowed?.bytes.toString(), "image"); assert.equal(allowed?.headers["content-disposition"], "attachment"); assert.equal(allowed?.headers["x-content-type-options"], "nosniff");
  fs.writeFileSync(path.join(f.root, "artifacts", "sha256", artifact.sha256, "bytes"), "tampered");
  assert.equal(f.repository.readAuthorized(artifact.id, access), null);
});

test("capability grants are exact and do not grant reads without media read capability", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const artifact = f.repository.ingest({ source: { kind: "data-url", value: "data:audio/wav;base64,c291bmQ=" }, ownerSubject: "alice", readGrants: ["capability:case-42"] });
  assert.equal(f.repository.readAuthorized(artifact.id, { subject: "bob", capabilities: ["case-42"] }), null);
  assert.equal(f.repository.readAuthorized(artifact.id, { subject: "bob", capabilities: ["media.artifact.read", "case-42"] })?.metadata.kind, "audio");
});
