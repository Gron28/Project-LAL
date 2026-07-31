export const AGENT_RUNTIME_SCHEMA_VERSION = 1;

export function evaluateSharedCompletion(input) {
  if (input.cancelled) return { outcome: "cancelled", reason: "The operator cancelled execution." };
  if (input.executionFault) return { outcome: "failed", reason: input.executionFault };
  if (input.blockedReason) return { outcome: "blocked", reason: input.blockedReason };
  const unmet = input.criteria.filter((criterion) => criterion.state !== "pass");
  if (input.unresolvedWorkIds.length || unmet.length || !input.requiredVerificationPassed) {
    return {
      outcome: "incomplete",
      reason: input.unresolvedWorkIds.length
        ? `Unresolved work remains: ${input.unresolvedWorkIds.join(", ")}.`
        : unmet.length
          ? `Acceptance is not proven for: ${unmet.map((criterion) => criterion.id).join(", ")}.`
          : "Required final verification did not pass.",
    };
  }
  return { outcome: "complete", reason: "Every required acceptance criterion has linked passing evidence." };
}

export function evaluateResearchCoverage(items, fetchedEvidenceIds) {
  const uncovered = items.filter((item) => item.unresolved || !item.evidenceIds.some((id) => fetchedEvidenceIds.has(id)));
  return {
    complete: items.length > 0 && uncovered.length === 0,
    uncoveredIds: uncovered.map((item) => item.id),
    contradictionIds: items.filter((item) => item.contradictory).map((item) => item.id),
  };
}

function sourceOrigin(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const labels = host.split(".");
    return labels.length > 2 ? labels.slice(-2).join(".") : host;
  } catch {
    return String(url).toLowerCase();
  }
}

function isExecutableIndex(source, target) {
  let state = "code";
  for (let index = 0; index < target; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "code"; index += 1; }
      continue;
    }
    if (state !== "code") {
      if (char === "\\") { index += 1; continue; }
      if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) state = "code";
      continue;
    }
    if (char === "/" && next === "/") { state = "line"; index += 1; }
    else if (char === "/" && next === "*") { state = "block"; index += 1; }
    else if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "template";
  }
  return state === "code";
}

export function evaluateResearchCollection(input) {
  const queries = [...new Set(input.queries.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  const sources = [...new Set(input.sources.map((item) => String(item).trim()).filter(Boolean))];
  const origins = [];
  const seen = new Set();
  let lastNewOriginIndex = -1;
  sources.forEach((url, index) => {
    const origin = sourceOrigin(url);
    if (!seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
      lastNewOriginIndex = index;
    }
  });
  const minQueries = input.minQueries ?? 3;
  const minOrigins = input.minOrigins ?? 2;
  const plateauFetches = input.plateauFetches ?? 3;
  const redundantTail = sources.length ? sources.length - 1 - lastNewOriginIndex : 0;
  const breadthMet = queries.length >= minQueries;
  const independenceMet = origins.length >= minOrigins;
  const plateaued = breadthMet && origins.length > 0 && redundantTail >= plateauFetches;
  return {
    passed: (breadthMet && independenceMet) || plateaued,
    reason: plateaued && !independenceMet ? "plateau" : "sufficient",
    queryCount: queries.length,
    sourceCount: sources.length,
    originCount: origins.length,
    origins,
    redundantTail,
    breadthMet,
    independenceMet,
    plateaued,
    missingQueries: Math.max(0, minQueries - queries.length),
    missingOrigins: Math.max(0, minOrigins - origins.length),
  };
}

export function validateStaticHtmlDocument(html) {
  const checks = [];
  checks.push({
    code: "html-structure",
    passed: /<html[\s>]/i.test(html) && /<body[\s>]/i.test(html),
    detail: "Document contains html and body elements.",
  });
  const openScripts = html.match(/<script\b[^>]*>/gi)?.length || 0;
  const closeScripts = html.match(/<\/script\s*>/gi)?.length || 0;
  checks.push({
    code: "script-balance",
    passed: openScripts === closeScripts,
    detail: `${openScripts} opening and ${closeScripts} closing script tags.`,
  });
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((match) => {
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(match[1] || "")?.[1]?.toLowerCase();
      return !type || /^(?:text\/javascript|application\/javascript|module)$/.test(type);
    })
    .map((match) => match[2] || "");
  const syntaxErrors = [];
  for (const script of scripts) {
    if (/^\s*(?:import|export)\b/m.test(script)) continue;
    try { new Function(script); } catch (error) { syntaxErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  checks.push({
    code: "javascript-syntax",
    passed: syntaxErrors.length === 0,
    detail: syntaxErrors.join("; ") || "Inline JavaScript parses.",
  });
  const ids = new Set([...html.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/gi)].map((match) => match[1] || match[2] || match[3]));
  const referenced = scripts.flatMap((script) => [
    ...[...script.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)]
      .filter((match) => isExecutableIndex(script, match.index))
      .map((match) => match[1]),
    ...[...script.matchAll(/querySelector(?:All)?\(\s*["']#([A-Za-z_][\w-]*)["']\s*\)/g)]
      .filter((match) => isExecutableIndex(script, match.index))
      .map((match) => match[1]),
  ]);
  const missing = [...new Set(referenced.filter((id) => !ids.has(id)))];
  checks.push({
    code: "element-references",
    passed: missing.length === 0,
    detail: missing.length ? `Missing ids: ${missing.map((id) => `"${id}"`).join(", ")}` : "Every statically referenced id exists.",
  });
  const remote = [...html.matchAll(/\b(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)].map((match) => match[1]);
  checks.push({
    code: "self-contained",
    passed: remote.length === 0,
    detail: remote.length ? `Remote assets: ${[...new Set(remote)].join(", ")}` : "No remote src/href dependencies.",
  });
  const placeholder = /\b(?:TODO|FIXME|TBD|IMPLEMENT ME|your code here|placeholder for|coming soon|not implemented)\b/i.exec(html);
  checks.push({
    code: "no-placeholder",
    passed: !placeholder,
    detail: placeholder ? `Unfinished marker: ${placeholder[0]}` : "No unfinished markers.",
  });
  const emptyHandlers = scripts.filter((script) => {
    const clean = script
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
      .replace(/`(?:\\.|[^`\\])*`/g, "``")
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
    return /addEventListener\(\s*['"][^'"]*['"]\s*,\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{\s*\}/.test(clean);
  }).length;
  checks.push({
    code: "nonempty-handlers",
    passed: emptyHandlers === 0,
    detail: emptyHandlers ? `${emptyHandlers} empty event handler(s).` : "No empty event handlers.",
  });
  const interactionClaimed = /\b(?:interactive|button|onclick)\b/i.test(html);
  checks.push({
    code: "interactive-script",
    passed: !interactionClaimed || scripts.length > 0,
    detail: !interactionClaimed || scripts.length > 0 ? "Interactive markup has script behavior." : "Interactive markup has no inline behavior.",
  });
  return {
    passed: checks.every((check) => check.passed),
    checks,
    uncheckedProperties: ["runtime console errors", "control behavior", "canvas rendering", "visual layout"],
  };
}

export class ArtifactAcceptanceRegistry {
  #adapters = new Map();
  register(adapter) {
    if (this.#adapters.has(adapter.id)) throw new Error(`artifact validator already registered: ${adapter.id}`);
    this.#adapters.set(adapter.id, adapter);
  }
  resolve(mediaType) {
    return [...this.#adapters.values()].find((adapter) => adapter.mediaTypes.includes(mediaType));
  }
  list() {
    return [...this.#adapters.keys()].sort();
  }
}
