#!/usr/bin/env node
// HTML-001 — the reliability benchmark defined in docs/PLAN.md.
//
// Drives the real `lal` client headlessly against a fixed prompt in a throwaway
// project directory, then validates what actually landed on disk in a real
// browser. The model's own claim of completion is ignored entirely; the runtime
// decides (PLAN Stage 6).
//
//   node scripts/html001.mjs --runs 10 --model qwen35-9b
//
// Emits one JSON record per run and a summary. The bar is 9 of 10 passing.
// Nothing in PLAN Stage 8 begins until that is met on Windows.
//
// Cross-platform by construction: no bash, no /usr/bin paths, Chrome is
// discovered per OS. Windows is a first-class target — it is where the
// failures were observed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- the prompt
// Fixed wording. Changing it invalidates every prior baseline, so treat this
// string as the benchmark's identity — version it rather than editing it.
const PROMPT_VERSION = 'html-001/v1';
const PROMPT = [
  'Create a single-file interactive website in a file named index.html in the current directory.',
  '',
  'It must show a bar chart of the five numbers 12, 45, 23, 67, 34 drawn on a <canvas id="chart">.',
  'Add a button with id="shuffle" that replaces the numbers with five new random values from 1 to 99 and redraws the chart.',
  'Add a button with id="reset" that restores the original five numbers and redraws.',
  'Show the current values as comma-separated text inside an element with id="values".',
  '',
  'Everything must be in that one file: no external assets, no network requests, no build step.',
  'When you are done, verify the file works before saying it is complete.',
].join('\n');

// Probes run inside the loaded page. These are the acceptance test — they are
// what "done" means, not the model's summary.
const PROBES = `
  probe('canvas #chart exists', !!$('#chart'));
  probe('button #shuffle exists', !!$('#shuffle'));
  probe('button #reset exists', !!$('#reset'));
  probe('element #values exists', !!$('#values'));

  const initial = ($('#values')?.textContent || '').trim();
  probe('values shows the five starting numbers',
        [12,45,23,67,34].every(n => initial.includes(String(n))));

  const blank = canvasBlank('#chart');
  probe('chart is actually drawn (canvas not blank)', blank === false);

  const before = canvasData('#chart');
  clickEl($('#shuffle'));
  await sleep(400);
  const afterText = ($('#values')?.textContent || '').trim();
  probe('shuffle changes the values text', afterText !== initial);
  probe('shuffle redraws the chart', canvasData('#chart') !== before);

  clickEl($('#reset'));
  await sleep(400);
  const resetText = ($('#values')?.textContent || '').trim();
  probe('reset restores the original values',
        [12,45,23,67,34].every(n => resetText.includes(String(n))));
`;

const HELPERS = `
  const __results = [];
  const probe = (name, pass) => __results.push({ name, pass: !!pass });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const canvasData = (sel) => { const c = $(sel); try { return c ? c.toDataURL() : null; } catch { return null; } };
  const canvasBlank = (sel) => {
    const c = $(sel); if (!c || !c.getContext) return null;
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const first = [d[0], d[1], d[2], d[3]].join();
      for (let i = 4; i < d.length; i += 4)
        if ([d[i], d[i+1], d[i+2], d[i+3]].join() !== first) return false;
      return true;
    } catch { return null; }
  };
  const clickEl = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return true;
  };
`;

// ------------------------------------------------------------------ plumbing
function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
            '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    win32: [`${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['LOCALAPPDATA'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
             '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  }[process.platform] || [];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

function readToken() {
  if (process.env.LAL_API_KEY) return process.env.LAL_API_KEY;
  // The token the host hands out; same source as ./start.sh --show-cli-token.
  for (const p of [path.join(REPO, 'web', '.data', 'cli-token'),
                   path.join(REPO, 'web', '.data', 'cli-devices.json')]) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (p.endsWith('.json')) {
        const j = JSON.parse(raw);
        const t = j.token || j?.devices?.[0]?.token;
        if (t) return t;
      } else if (raw) return raw;
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------ trace analysis
/** Everything we can learn about *process* from the stream-json trace. */
function analyzeTrace(events) {
  const toolUses = [];
  const toolResults = new Map();
  let result = null, init = null;

  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'init') init = e;
    if (e.type === 'result') result = e;
    const content = (e.message && Array.isArray(e.message.content)) ? e.message.content : [];
    for (const b of content) {
      if (b?.type === 'tool_use') toolUses.push(b);
      if (b?.type === 'tool_result') toolResults.set(b.tool_use_id, b);
    }
  }

  const failures = [...toolResults.values()].filter(r => r.is_error);

  // Retries: the same tool called with byte-identical arguments more than once.
  const sig = new Map();
  for (const t of toolUses) {
    const k = t.name + '\u0000' + JSON.stringify(t.input ?? {});
    sig.set(k, (sig.get(k) || 0) + 1);
  }
  const retries = [...sig.values()].reduce((n, c) => n + (c - 1), 0);

  // Writes per path, with the artifact_validation hash the runtime emits.
  // Rewriting a path with different content is regenerated work (condition 8).
  const writes = [];
  for (const t of toolUses) {
    if (!/^(write_file|edit)$/.test(t.name)) continue;
    const p = t.input?.file_path ?? t.input?.path ?? null;
    const res = toolResults.get(t.id);
    const hash = /hash=sha256:([0-9a-f]{8,})/.exec(String(res?.content ?? ''))?.[1] ?? null;
    writes.push({
      tool: t.name,
      path: p,
      hash,
      bytes: typeof t.input?.content === 'string' ? t.input.content.length : null,
      failed: !!res?.is_error,
    });
  }
  const byPath = new Map();
  for (const w of writes) if (w.path) byPath.set(w.path, [...(byPath.get(w.path) || []), w]);
  let regenerated = 0;
  for (const [, ws] of byPath) {
    const fullWrites = ws.filter(w => w.tool === 'write_file' && !w.failed);
    if (fullWrites.length > 1) regenerated += fullWrites.length - 1;
  }
  const wastedBytes = [...byPath.values()]
    .flatMap(ws => ws.filter(w => w.tool === 'write_file').slice(0, -1))
    .reduce((n, w) => n + (w.bytes || 0), 0);

  // Condition 9: did the agent verify after its last write, before finishing?
  const lastWriteIdx = toolUses.map(t => t.name).lastIndexOf('write_file');
  const validatedAfterWrite = lastWriteIdx !== -1 && toolUses
    .slice(lastWriteIdx + 1)
    .some(t => /^(read_file|run_shell_command|glob|grep_search|list_directory)$/.test(t.name));

  return {
    model: init?.model ?? null,
    sessionId: init?.session_id ?? null,
    turns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    apiMs: result?.duration_api_ms ?? null,
    tokens: result?.usage ?? null,
    isError: result?.is_error ?? null,
    finalText: result?.result ?? null,
    permissionDenials: (result?.permission_denials ?? []).length,
    toolCalls: toolUses.length,
    toolFailures: failures.length,
    toolFailureNames: [...new Set(failures.map(f =>
      toolUses.find(t => t.id === f.tool_use_id)?.name ?? '?'))],
    retries,
    writes,
    regeneratedWrites: regenerated,
    regeneratedBytes: wastedBytes,
    validatedAfterWrite,
  };
}

// ------------------------------------------------------------ page validation
async function validatePage(file, keepShot) {
  const chrome = findChrome();
  if (!chrome) return { error: 'no Chrome/Chromium found (set CHROME_PATH)' };
  // puppeteer-core lives in web/'s tree; import it by file URL so this script
  // needs no node_modules of its own.
  const entry = path.join(REPO, 'web', 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js');
  const { launch } = await import(pathToFileURL(entry).href);
  let browser = null;
  try {
    browser = await launch({ executablePath: chrome, headless: true,
                             args: ['--hide-scrollbars', '--mute-audio', '--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 720 });
    const pageErrors = [], consoleErrors = [], requests = [];
    page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('request', r => { if (!r.url().startsWith('file://') && !r.url().startsWith('data:')) requests.push(r.url()); });

    await page.goto('file://' + file, { waitUntil: 'load', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));

    let probes = [], probeCrash = null;
    try {
      probes = await page.evaluate(`(async () => { ${HELPERS} ${PROBES}\n return __results; })()`);
    } catch (e) { probeCrash = String(e?.message || e).slice(0, 200); }

    let shot = null;
    if (keepShot) {
      shot = file.replace(/index\.html$/, 'screenshot.png');
      try { await page.screenshot({ path: shot }); } catch { shot = null; }
    }
    return { pageErrors, consoleErrors, externalRequests: requests, probes, probeCrash, shot };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 240) };
  } finally { try { await browser?.close(); } catch {} }
}

// ------------------------------------------------------------------- one run
async function runOnce(i, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html001-'));
  const started = Date.now();
  const tracePath = path.join(dir, 'trace.ndjson');
  const trace = fs.createWriteStream(tracePath);
  const stderrChunks = [];

  const env = { ...process.env, LAL_GATEWAY_URL: opts.gateway, LAL_API_KEY: opts.token };
  const args = ['-p', PROMPT, '--approval-mode=auto-edit', '--output-format', 'stream-json'];
  if (opts.model) args.push('--model', opts.model);

  const code = await new Promise((resolve) => {
    const child = spawn(opts.lal, args, { cwd: dir, env, shell: process.platform === 'win32' });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, opts.timeoutMs);
    child.stdout.pipe(trace);
    child.stderr.on('data', d => stderrChunks.push(d));
    child.on('error', () => resolve(-1));
    child.on('close', c => { clearTimeout(killer); resolve(c); });
  });
  const wallMs = Date.now() - started;

  const events = fs.readFileSync(tracePath, 'utf8').split('\n')
    .filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const t = analyzeTrace(events);

  const file = path.join(dir, 'index.html');
  const exists = fs.existsSync(file);
  const page = exists ? await validatePage(file, opts.keep) : { error: 'index.html was never created' };
  const probesFailed = (page.probes || []).filter(p => !p.pass).map(p => p.name);
  const probesRun = (page.probes || []).length;

  // The nine conditions. Anything we cannot yet source honestly is null, never
  // an optimistic default — PLAN rule 7.
  const c = {
    1: exists,
    2: probesRun > 0 && probesFailed.length === 0,
    3: !page.error && (page.pageErrors || []).length === 0,
    4: !page.error && (page.consoleErrors || []).length === 0,
    5: probesRun > 0 && !probesFailed.some(n => /shuffle|reset|button/i.test(n)),
    6: probesRun > 0 && !probesFailed.some(n => /canvas|drawn|chart/i.test(n)),
    7: null,                       // resume-not-restart: needs Stage 3 instrumentation
    8: t.regeneratedWrites === 0,
    9: t.validatedAfterWrite,
  };
  const known = Object.values(c).filter(v => v !== null);
  const pass = known.every(Boolean) && known.length > 0;

  const record = {
    benchmark: PROMPT_VERSION,
    run: i,
    pass,
    conditions: c,
    unmeasured: Object.entries(c).filter(([, v]) => v === null).map(([k]) => Number(k)),
    metrics: {
      completed: exists,
      browserLoaded: !page.error && !!exists,
      functionalPass: probesRun > 0 && probesFailed.length === 0,
      toolFailures: t.toolFailures,
      retries: t.retries,
      tokens: t.tokens?.total_tokens ?? null,
      regeneratedWrites: t.regeneratedWrites,
      regeneratedBytes: t.regeneratedBytes,
      wallMs,
      apiMs: t.apiMs,
      turns: t.turns,
    },
    detail: {
      model: t.model,
      exitCode: code,
      timedOut: wallMs >= opts.timeoutMs,
      probesRun,
      probesFailed,
      probeCrash: page.probeCrash ?? null,
      pageErrors: page.pageErrors ?? [],
      consoleErrors: page.consoleErrors ?? [],
      externalRequests: page.externalRequests ?? [],
      toolFailureNames: t.toolFailureNames,
      permissionDenials: t.permissionDenials,
      writes: t.writes.map(w => ({ tool: w.tool, path: w.path ? path.basename(w.path) : null, hash: w.hash, bytes: w.bytes, failed: w.failed })),
      validationError: page.error ?? null,
      agentClaim: (t.finalText || '').slice(0, 300),
      stderrTail: Buffer.concat(stderrChunks).toString('utf8').split('\n').slice(-6).join('\n'),
    },
    dir: opts.keep ? dir : null,
  };

  if (!opts.keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  return record;
}

// ---------------------------------------------------------------------- main
const opts = {
  runs: Number(arg('runs', 1)),
  model: arg('model', null),
  gateway: arg('gateway', process.env.LAL_GATEWAY_URL || 'http://127.0.0.1:8770'),
  lal: arg('lal', process.env.LAL_BIN || 'lal'),
  timeoutMs: Number(arg('timeout', 900)) * 1000,
  keep: !!arg('keep', false),
  out: arg('out', null),
  token: readToken(),
};

if (!opts.token) {
  console.error('No LAL token. Set LAL_API_KEY, or run ./start.sh --show-cli-token and export it.');
  process.exit(2);
}

const records = [];
for (let i = 1; i <= opts.runs; i++) {
  process.stderr.write(`\n=== HTML-001 run ${i}/${opts.runs} ===\n`);
  const r = await runOnce(i, opts);
  records.push(r);
  const failed = Object.entries(r.conditions).filter(([, v]) => v === false).map(([k]) => k);
  process.stderr.write(
    `${r.pass ? 'PASS' : 'FAIL'}  ${Math.round(r.metrics.wallMs / 1000)}s  ` +
    `tokens=${r.metrics.tokens ?? '?'}  ` +
    `toolFailures=${r.metrics.toolFailures} retries=${r.metrics.retries} ` +
    `regen=${r.metrics.regeneratedWrites}` +
    (failed.length ? `  failed conditions: ${failed.join(',')}` : '') + '\n');
  if (r.detail.probesFailed.length) process.stderr.write(`  probes failed: ${r.detail.probesFailed.join(' | ')}\n`);
  if (r.detail.validationError) process.stderr.write(`  validation: ${r.detail.validationError}\n`);
}

const passes = records.filter(r => r.pass).length;
const num = (xs) => xs.filter(x => typeof x === 'number');
const mean = (xs) => num(xs).length ? Math.round(num(xs).reduce((a, b) => a + b, 0) / num(xs).length) : null;
const summary = {
  benchmark: PROMPT_VERSION,
  when: new Date().toISOString(),
  host: { platform: process.platform, node: process.version },
  model: records[0]?.detail.model ?? opts.model,
  runs: records.length,
  passes,
  passRate: records.length ? passes / records.length : 0,
  bar: '9 of 10 consecutive, unattended, on Windows',
  meetsBar: records.length >= 10 && passes >= 9,
  unmeasuredConditions: records[0]?.unmeasured ?? [],
  averages: {
    wallMs: mean(records.map(r => r.metrics.wallMs)),
    tokens: mean(records.map(r => r.metrics.tokens)),
    toolFailures: mean(records.map(r => r.metrics.toolFailures)),
    retries: mean(records.map(r => r.metrics.retries)),
    regeneratedWrites: mean(records.map(r => r.metrics.regeneratedWrites)),
    turns: mean(records.map(r => r.metrics.turns)),
  },
  conditionFailureCounts: [1,2,3,4,5,6,7,8,9].reduce((acc, k) => {
    acc[k] = records.filter(r => r.conditions[k] === false).length; return acc;
  }, {}),
};

const report = { summary, records };
if (opts.out) { fs.writeFileSync(opts.out, JSON.stringify(report, null, 2)); process.stderr.write(`\nwrote ${opts.out}\n`); }
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.stderr.write(`\n=== ${passes}/${records.length} passed ===\n`);
process.exit(passes === records.length ? 0 : 1);
