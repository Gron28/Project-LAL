import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage, type UsageRecord } from "./usage-ledger.ts";

const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m, d, h, min).getTime();

const rec = (ts: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  ts,
  dev: "dev-1",
  model: "qwen35-9b",
  prompt: 100,
  completion: 50,
  total: 150,
  ...over,
});

test("totals sum prompt, completion and request count", () => {
  const s = summarizeUsage([rec(at(2026, 6, 20, 9)), rec(at(2026, 6, 20, 10))]);
  assert.equal(s.totals.requests, 2);
  assert.equal(s.totals.prompt, 200);
  assert.equal(s.totals.completion, 100);
  assert.equal(s.totals.total, 300);
});

test("hour buckets always cover all 24 hours", () => {
  // A chart that omits 3am reads as "no data" rather than "no activity", so empty
  // hours must be present as zeroes.
  const s = summarizeUsage([rec(at(2026, 6, 20, 9))]);
  assert.equal(s.byHour.length, 24);
  assert.deepEqual(
    s.byHour.map((b) => b.key).slice(0, 3),
    ["00", "01", "02"],
  );
  assert.equal(s.byHour.find((b) => b.key === "09")?.requests, 1);
  assert.equal(s.byHour.find((b) => b.key === "03")?.requests, 0);
});

test("weekday buckets are Monday-first and complete", () => {
  const s = summarizeUsage([]);
  assert.deepEqual(
    s.byWeekday.map((b) => b.key),
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  );
});

test("busiest hour is the highest-token hour, not the most frequent", () => {
  // One big request must beat three small ones: the question is where the tokens
  // went, and a cheap-but-chatty hour is not the expensive one.
  const s = summarizeUsage([
    rec(at(2026, 6, 20, 9), { total: 10, prompt: 10, completion: 0 }),
    rec(at(2026, 6, 20, 9), { total: 10, prompt: 10, completion: 0 }),
    rec(at(2026, 6, 20, 9), { total: 10, prompt: 10, completion: 0 }),
    rec(at(2026, 6, 20, 22), { total: 5000, prompt: 4000, completion: 1000 }),
  ]);
  assert.equal(s.busiestHour?.key, "22");
  assert.equal(s.busiestHour?.total, 5000);
});

test("models rank by tokens consumed", () => {
  const s = summarizeUsage([
    rec(at(2026, 6, 20, 9), { model: "small", total: 10 }),
    rec(at(2026, 6, 20, 9), { model: "big", total: 900 }),
    rec(at(2026, 6, 20, 9), { model: "small", total: 10 }),
  ]);
  assert.deepEqual(
    s.byModel.map((b) => [b.key, b.total, b.requests]),
    [
      ["big", 900, 1],
      ["small", 20, 2],
    ],
  );
});

test("devices are grouped by friendly name when present, id otherwise", () => {
  const s = summarizeUsage([
    rec(at(2026, 6, 20, 9), { dev: "d1", devName: "AT-DESIGN" }),
    rec(at(2026, 6, 20, 9), { dev: "d2", devName: undefined }),
  ]);
  assert.deepEqual(s.byDevice.map((b) => b.key).sort(), ["AT-DESIGN", "d2"]);
});

test("an empty ledger reports nulls instead of a fabricated peak", () => {
  // "Unknown stays visibly unknown": a zero-data summary must not name 00:00 as
  // the busiest hour just because it sorts first.
  const s = summarizeUsage([]);
  assert.equal(s.busiestHour, null);
  assert.equal(s.busiestDay, null);
  assert.equal(s.busiestWeekday, null);
  assert.equal(s.window.since, null);
  assert.equal(s.totals.requests, 0);
});

test("day buckets are chronological", () => {
  const s = summarizeUsage([
    rec(at(2026, 6, 22, 9)),
    rec(at(2026, 6, 20, 9)),
    rec(at(2026, 6, 21, 9)),
  ]);
  assert.deepEqual(
    s.byDay.map((b) => b.key),
    ["2026-07-20", "2026-07-21", "2026-07-22"],
  );
});
