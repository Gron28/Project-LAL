import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rotateLogFile } from "./log-rotation.ts";

test("copy-truncate rotation keeps a live writer on the active log", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lal-log-"));
  const file = path.join(directory, "server.log");
  const writer = fs.openSync(file, "a");
  try {
    fs.writeSync(writer, "before rotation\n");
    assert.equal(rotateLogFile(file, 1, 2), true);
    fs.writeSync(writer, "after rotation\n");
    assert.match(fs.readFileSync(`${file}.1`, "utf8"), /before rotation/);
    assert.match(fs.readFileSync(file, "utf8"), /after rotation/);
  } finally {
    fs.closeSync(writer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
