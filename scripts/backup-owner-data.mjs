#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LARGE_REPRODUCIBLE = /\.(?:gguf|safetensors|bin|pt|pth)$/i;

const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function includedSources(repo) {
  return [
    path.join(repo, "web", ".data"),
    path.join(repo, "data"),
    path.join(repo, "models"),
  ].filter((source) => fs.existsSync(source));
}

export function createOwnerBackup(destination, repo = REPO) {
  const root = path.resolve(destination, `project-lal-owner-${stamp()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = [];
  for (const source of includedSources(repo)) {
    const relativeBase = path.relative(repo, source);
    fs.cpSync(source, path.join(root, relativeBase), {
      recursive: true,
      filter: (candidate) => !LARGE_REPRODUCIBLE.test(candidate),
    });
  }
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (absolute !== path.join(root, "manifest.json")) {
        fs.chmodSync(absolute, 0o600);
        files.push({ path: path.relative(root, absolute), size: fs.statSync(absolute).size, sha256: hashFile(absolute) });
      }
    }
  };
  walk(root);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceRepo: repo,
    excludes: ["reproducible model weights (*.gguf, *.safetensors, *.bin, *.pt, *.pth)"],
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return { root, manifest };
}

export function restoreOwnerBackup(backup, destination) {
  const source = path.resolve(backup);
  const target = path.resolve(destination);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error("restore destination must be empty");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const item of manifest.files) {
    const input = path.resolve(source, item.path);
    const output = path.resolve(target, item.path);
    if (!input.startsWith(source + path.sep) || !output.startsWith(target + path.sep)) throw new Error("unsafe manifest path");
    if (hashFile(input) !== item.sha256) throw new Error(`backup hash mismatch: ${item.path}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(input, output);
    fs.chmodSync(output, 0o600);
    if (hashFile(output) !== item.sha256) throw new Error(`restore hash mismatch: ${item.path}`);
  }
  return { target, files: manifest.files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const restoreIndex = process.argv.indexOf("--restore");
  if (restoreIndex >= 0) {
    const backup = process.argv[restoreIndex + 1];
    const toIndex = process.argv.indexOf("--to");
    const target = toIndex >= 0 ? process.argv[toIndex + 1] : "";
    if (!backup || !target) throw new Error("usage: backup-owner-data.mjs --restore BACKUP --to EMPTY_DIRECTORY");
    console.log(JSON.stringify(restoreOwnerBackup(backup, target), null, 2));
  } else {
    const destination = process.argv[2] || path.join(REPO, "backups");
    console.log(JSON.stringify(createOwnerBackup(destination), null, 2));
  }
}
