import fs from "node:fs";

export class DurableDagRunner {
  constructor(options = {}) {
    this.journalPath = options.journalPath;
    this.runId = options.runId || "run-default";
    this.maxAttempts = options.maxAttempts ?? 100;
    this.wallTimeMs = options.wallTimeMs ?? 30_000;
  }

  async run(nodes, options = {}) {
    void fs;
    void nodes;
    void options;
    throw new Error("not implemented");
  }
}
