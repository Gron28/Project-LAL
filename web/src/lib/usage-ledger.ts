import fs from "node:fs";
import path from "node:path";

/**
 * Durable per-request token ledger.
 *
 * The gateway has always COMPUTED usage (`publishUsage` in the chat-completions
 * route) and then handed it to `appendHostObservationForClientDevice`, which only
 * writes when a *running client run* owned by that device exists
 * (`runs.ts`: executionLocation === "client" && status === "running"). Ordinary
 * chat and CLI turns have no such run, so their usage was silently discarded.
 * Measured 2026-07-25: 61 usage events across 224 run logs, against ~15,900
 * `think` events — i.e. usage was recorded for HIVE workflow nodes and almost
 * nothing else, and device records held zero observations.
 *
 * So this is a separate append-only ledger with one job: never lose a request.
 * It is deliberately dumb — one JSON object per line, one file per month, no
 * index, no database. Aggregation happens on read (`summarizeUsage`), because at
 * a few thousand requests a month a full scan costs less than maintaining
 * rollups, and a scan cannot drift out of sync with the raw data.
 */

const USAGE_DIR = path.join(process.cwd(), ".data", "usage");

/** One recorded request. Field names are terse because every line pays for them. */
export type UsageRecord = {
  /** Epoch ms when the request STARTED, so bucketing reflects when work began. */
  ts: number;
  /** Device that made the request, or null when unauthenticated/unknown. */
  dev: string | null;
  /** Human-readable device name when the client sent one. */
  devName?: string;
  /** Public model name as requested (not the internal runtime profile). */
  model: string;
  prompt: number;
  completion: number;
  total: number;
  /** Serving context the request actually ran with, when known. */
  ctx?: number;
  /** Wall-clock ms from request start to stream close. */
  ms?: number;
  /** Where the request came from, for splitting CLI from web traffic. */
  src?: string;
};

function monthFile(ts: number): string {
  const d = new Date(ts);
  const name = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.ndjson`;
  return path.join(USAGE_DIR, name);
}

/**
 * Append one record. Never throws: losing telemetry must not fail a user's
 * request, which is the whole reason the previous mechanism's silent drop went
 * unnoticed for so long — so failures are logged loudly instead of swallowed.
 */
export function recordUsage(record: UsageRecord): void {
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFileSync(monthFile(record.ts), `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.warn(
      `[lal-usage] failed to record usage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read records overlapping [since, until), oldest first. */
export function readUsage(since = 0, until = Number.MAX_SAFE_INTEGER): UsageRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(USAGE_DIR).filter((f) => f.endsWith(".ndjson")).sort();
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(USAGE_DIR, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: UsageRecord;
      try {
        record = JSON.parse(line) as UsageRecord;
      } catch {
        // A torn final line from a crash mid-append. Skip it rather than
        // discarding the whole month.
        continue;
      }
      if (typeof record?.ts !== "number") continue;
      if (record.ts >= since && record.ts < until) out.push(record);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export type UsageBucket = { key: string; total: number; prompt: number; completion: number; requests: number };
export type UsageSummary = {
  totals: { total: number; prompt: number; completion: number; requests: number };
  /** Local-time YYYY-MM-DD buckets. */
  byDay: UsageBucket[];
  /** Local hour-of-day 00..23, always all 24 so a chart has no gaps. */
  byHour: UsageBucket[];
  /** Local day-of-week, Monday first, always all 7. */
  byWeekday: UsageBucket[];
  byModel: UsageBucket[];
  byDevice: UsageBucket[];
  /** Highest-token hour-of-day, or null when there is no data at all. */
  busiestHour: UsageBucket | null;
  busiestWeekday: UsageBucket | null;
  busiestDay: UsageBucket | null;
  /** Records the ledger holds outside the requested window, for honesty in the UI. */
  window: { since: number | null; until: number | null };
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function bucketize(
  records: UsageRecord[],
  keyOf: (r: UsageRecord) => string,
  seed: string[] = [],
): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  // Seeded keys keep empty hours/weekdays present as zeroes. A chart that
  // silently omits 3am reads as "no data" rather than "no activity".
  for (const key of seed) {
    map.set(key, { key, total: 0, prompt: 0, completion: 0, requests: 0 });
  }
  for (const r of records) {
    const key = keyOf(r);
    const bucket = map.get(key) ?? { key, total: 0, prompt: 0, completion: 0, requests: 0 };
    bucket.total += r.total || 0;
    bucket.prompt += r.prompt || 0;
    bucket.completion += r.completion || 0;
    bucket.requests += 1;
    map.set(key, bucket);
  }
  return [...map.values()];
}

/** Highest total, ties broken by request count then key, so it is deterministic. */
function peak(buckets: UsageBucket[]): UsageBucket | null {
  const withData = buckets.filter((b) => b.requests > 0);
  if (withData.length === 0) return null;
  return withData.reduce((best, b) =>
    b.total > best.total ||
    (b.total === best.total && b.requests > best.requests) ||
    (b.total === best.total && b.requests === best.requests && b.key < best.key)
      ? b
      : best,
  );
}

/**
 * Aggregate records. Buckets use LOCAL time on purpose: "which hours am I most
 * active" is a question about the operator's day, not about UTC.
 */
export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const pad = (n: number) => String(n).padStart(2, "0");
  const byDay = bucketize(records, (r) => {
    const d = new Date(r.ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }).sort((a, b) => a.key.localeCompare(b.key));

  const byHour = bucketize(
    records,
    (r) => pad(new Date(r.ts).getHours()),
    Array.from({ length: 24 }, (_, i) => pad(i)),
  ).sort((a, b) => a.key.localeCompare(b.key));

  const byWeekday = bucketize(
    records,
    // getDay() is Sunday-first; shift so Monday leads, which matches how a work
    // week is read.
    (r) => WEEKDAYS[(new Date(r.ts).getDay() + 6) % 7],
    WEEKDAYS,
  ).sort((a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key));

  const byModel = bucketize(records, (r) => r.model || "unknown").sort((a, b) => b.total - a.total);
  const byDevice = bucketize(records, (r) => r.devName || r.dev || "unknown").sort(
    (a, b) => b.total - a.total,
  );

  const totals = records.reduce(
    (acc, r) => ({
      total: acc.total + (r.total || 0),
      prompt: acc.prompt + (r.prompt || 0),
      completion: acc.completion + (r.completion || 0),
      requests: acc.requests + 1,
    }),
    { total: 0, prompt: 0, completion: 0, requests: 0 },
  );

  return {
    totals,
    byDay,
    byHour,
    byWeekday,
    byModel,
    byDevice,
    busiestHour: peak(byHour),
    busiestWeekday: peak(byWeekday),
    busiestDay: peak(byDay),
    window: {
      since: records.length ? records[0].ts : null,
      until: records.length ? records[records.length - 1].ts : null,
    },
  };
}
