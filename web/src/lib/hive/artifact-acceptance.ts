import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TaskEnvelope } from "./contracts.ts";
import { validateStaticHtmlDocument } from "@lal/protocol/agent-runtime";

export type ArtifactAcceptanceReport = {
  artifactPath: string;
  passed: boolean;
  checks: { code: string; passed: boolean; detail: string }[];
  unchecked: string[];
};

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((item): item is string => !!item);
  return candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || null;
}

export function inferArtifactPath(envelope: TaskEnvelope, workspace: string): string {
  const declared = envelope.deliverables?.find((item) => item.required && item.path)?.path;
  const mentioned = `${envelope.objective} ${envelope.requiredOutput}`.match(/\b[\w.-]+\.html?\b/i)?.[0];
  const relative = declared || mentioned || "index.html";
  const root = path.resolve(workspace);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("artifact path escapes the workspace");
  return target;
}

export function staticHtmlAcceptance(artifactPath: string, html: string): ArtifactAcceptanceReport {
  const shared = validateStaticHtmlDocument(html);
  return {
    artifactPath,
    passed: shared.passed,
    checks: shared.checks,
    unchecked: shared.uncheckedProperties,
  };
}

export async function validateHtmlArtifact(envelope: TaskEnvelope, workspace: string): Promise<ArtifactAcceptanceReport> {
  const artifactPath = inferArtifactPath(envelope, workspace);
  if (!fs.existsSync(artifactPath)) {
    return { artifactPath, passed: false, checks: [{ code: "artifact-exists", passed: false, detail: "Required HTML artifact is missing." }], unchecked: [] };
  }
  const report = staticHtmlAcceptance(artifactPath, fs.readFileSync(artifactPath, "utf8"));
  if (!report.passed) return report;
  const chrome = findChrome();
  if (!chrome) {
    report.passed = false;
    report.checks.push({ code: "browser-available", passed: false, detail: "No Chrome/Chromium executable was available for behavioral validation." });
    return report;
  }
  const { launch } = await import("puppeteer-core");
  const browser = await launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error instanceof Error ? error.message : String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(pathToFileURL(artifactPath).href, { waitUntil: "load", timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    report.checks.push({ code: "browser-load", passed: errors.length === 0, detail: errors.join("; ") || "Loaded without uncaught or console errors." });
    report.unchecked = report.unchecked.filter((item) => item !== "runtime console errors");
    if (/\bchart\b/i.test(envelope.objective) && /\bshuffle\b/i.test(envelope.objective) && /\breset\b/i.test(envelope.objective)) {
      const probes = await page.evaluate(async () => {
        const chart = document.querySelector<HTMLCanvasElement>("#chart");
        const values = document.querySelector<HTMLElement>("#values");
        const shuffle = document.querySelector<HTMLElement>("#shuffle");
        const reset = document.querySelector<HTMLElement>("#reset");
        const initial = values?.textContent || "";
        const before = chart?.toDataURL() || "";
        shuffle?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const changed = !!values && values.textContent !== initial && !!chart && chart.toDataURL() !== before;
        reset?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          elements: !!chart && !!values && !!shuffle && !!reset,
          changed,
          reset: [12, 45, 23, 67, 34].every((number) => (values?.textContent || "").includes(String(number))),
        };
      });
      report.checks.push(
        { code: "html001-elements", passed: probes.elements, detail: "Required canvas, values, shuffle, and reset elements." },
        { code: "html001-shuffle", passed: probes.changed, detail: "Shuffle changes values and redraws the canvas." },
        { code: "html001-reset", passed: probes.reset, detail: "Reset restores the original values." },
      );
      report.unchecked = report.unchecked.filter((item) => !["control behavior", "canvas rendering"].includes(item));
    }
    if (!/\b(visual|layout|design|style|responsive|appearance)\b/i.test(envelope.objective)) {
      report.unchecked = report.unchecked.filter((item) => item !== "visual layout");
    }
    if (!/\b(interactive|button|click|control|input|shuffle|reset)\b/i.test(envelope.objective)) {
      report.unchecked = report.unchecked.filter((item) => item !== "control behavior");
    }
    if (!/\b(canvas|chart|draw|paint|game)\b/i.test(envelope.objective)) {
      report.unchecked = report.unchecked.filter((item) => item !== "canvas rendering");
    }
    report.passed = report.checks.every((check) => check.passed);
    return report;
  } finally {
    await browser.close();
  }
}
