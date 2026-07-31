import fs from "node:fs";
import path from "node:path";

export function rotateLogFile(file: string, maxBytes = 5 * 1024 * 1024, history = 3): boolean {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= maxBytes) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let index = Math.max(1, history - 1); index >= 1; index--) {
    const source = `${file}.${index}`;
    const target = `${file}.${index + 1}`;
    if (fs.existsSync(source)) fs.renameSync(source, target);
  }
  fs.copyFileSync(file, `${file}.1`);
  // Copy-truncate preserves the inode held by a live llama-server process. A
  // rename would strand new messages in the rotated file until model restart.
  const descriptor = fs.openSync(file, "r+");
  try { fs.ftruncateSync(descriptor, 0); } finally { fs.closeSync(descriptor); }
  return true;
}
