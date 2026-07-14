import fs from "node:fs";
import path from "node:path";

export class DurableDagRunner {
  constructor(options = {}) {
    this.journalPath = options.journalPath;
    this.runId = options.runId || "run-default";
    this.maxAttempts = options.maxAttempts ?? 100;
    this.wallTimeMs = options.wallTimeMs ?? 30_000;
  }

  async run(nodes, options = {}) {
    this.#validate(nodes);
    const signal = options.signal;
    const startedAt = Date.now();
    const journal = this.#recover();
    let seq = journal.seq;
    const completed = new Set(journal.completed);
    const attempts = { ...journal.attempts };
    const errors = [...journal.errors];
    let totalAttempts = Object.values(attempts).reduce((sum, value) => sum + value, 0);

    const append = (type, nodeId = null, attempt = 0, detail = undefined) => {
      const record = { seq: ++seq, ts: Date.now(), runId: this.runId, nodeId, attempt, type, ...(detail === undefined ? {} : { detail }) };
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      const fd = fs.openSync(this.journalPath, "a");
      try { fs.writeSync(fd, JSON.stringify(record) + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    };
    const summary = (status) => ({ status, completed: nodes.filter((node) => completed.has(node.id)).map((node) => node.id), attempts, errors, journalSeq: seq });
    const cancelled = () => {
      append("run_cancelled", null, 0, "abort signal received");
      return summary("cancelled");
    };

    append("run_started");
    while (completed.size < nodes.length) {
      if (signal?.aborted) return cancelled();
      if (Date.now() - startedAt > this.wallTimeMs) {
        const error = `wall-time budget exceeded (${this.wallTimeMs}ms)`;
        errors.push(error); append("run_failed", null, 0, error); return summary("failed");
      }
      const ready = nodes.find((node) => !completed.has(node.id) && node.dependsOn.every((id) => completed.has(id)));
      if (!ready) {
        const error = "workflow blocked: no node has all dependencies completed";
        errors.push(error); append("run_failed", null, 0, error); return summary("failed");
      }

      const allowedAttempts = (ready.retries ?? 0) + 1;
      let succeeded = false;
      while (!succeeded && (attempts[ready.id] ?? 0) < allowedAttempts) {
        if (signal?.aborted) return cancelled();
        if (Date.now() - startedAt > this.wallTimeMs) {
          const error = `wall-time budget exceeded (${this.wallTimeMs}ms)`;
          errors.push(error); append("run_failed", ready.id, attempts[ready.id] ?? 0, error); return summary("failed");
        }
        if (totalAttempts >= this.maxAttempts) {
          const error = `global attempt budget exhausted (${this.maxAttempts})`;
          errors.push(error); append("run_failed", ready.id, attempts[ready.id] ?? 0, error); return summary("failed");
        }
        const attempt = (attempts[ready.id] ?? 0) + 1;
        attempts[ready.id] = attempt; totalAttempts++;
        append("node_started", ready.id, attempt);
        try {
          await ready.run({ runId: this.runId, nodeId: ready.id, attempt, idempotencyKey: `${this.runId}:${ready.id}:${attempt}`, signal });
          if (signal?.aborted) return cancelled();
          completed.add(ready.id); succeeded = true;
          append("node_succeeded", ready.id, attempt);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          append("node_failed", ready.id, attempt, message);
          if (attempt >= allowedAttempts) {
            errors.push(`node ${ready.id} failed after ${attempt} attempt(s): ${message}`);
            append("run_failed", ready.id, attempt, message);
            return summary("failed");
          }
        }
      }
    }
    append("run_succeeded");
    return summary("succeeded");
  }

  #validate(nodes) {
    if (!Array.isArray(nodes)) throw new Error("nodes must be an array");
    const ids = new Set();
    for (const node of nodes) {
      if (!node || typeof node.id !== "string" || !node.id || typeof node.run !== "function") throw new Error("every node needs an id and run function");
      if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      ids.add(node.id); node.dependsOn ??= [];
    }
    for (const node of nodes) for (const dependency of node.dependsOn) if (!ids.has(dependency)) throw new Error(`missing dependency: ${dependency}`);
    const visiting = new Set(), visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) throw new Error(`cycle detected at: ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const node = nodes.find((candidate) => candidate.id === id);
      for (const dependency of node.dependsOn) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const node of nodes) visit(node.id);
  }

  #recover() {
    const state = { seq: 0, completed: [], attempts: {}, errors: [] };
    if (!this.journalPath || !fs.existsSync(this.journalPath)) return state;
    const raw = fs.readFileSync(this.journalPath, "utf8");
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch {
        // A process can die between write and newline.  Only that final partial
        // line is safe to ignore; any earlier corruption makes recovery unsafe.
        if (index === lines.length - 1 && !raw.endsWith("\n")) break;
        throw new Error(`corrupt journal at line ${index + 1}`);
      }
      if (!record || record.runId !== this.runId || typeof record.seq !== "number" || record.seq <= state.seq) throw new Error(`corrupt journal at line ${index + 1}`);
      state.seq = record.seq;
      if (record.nodeId && typeof record.attempt === "number") state.attempts[record.nodeId] = Math.max(state.attempts[record.nodeId] ?? 0, record.attempt);
      if (record.type === "node_succeeded" && record.nodeId && !state.completed.includes(record.nodeId)) state.completed.push(record.nodeId);
      if (record.type === "run_failed" && record.detail) state.errors.push(String(record.detail));
    }
    return state;
  }
}
