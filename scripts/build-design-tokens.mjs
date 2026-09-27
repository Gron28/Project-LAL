#!/usr/bin/env node
// Generates every surface's palette from design/tokens.json so the web app and
// the CLI cannot drift apart again (they did twice: blue-teal web vs lime CLI,
// then a third palette in the CLI's brand-colors.ts).
//
//   node scripts/build-design-tokens.mjs          write outputs
//   node scripts/build-design-tokens.mjs --check  fail if outputs are stale
//
// Both modes also fail when a text/background pair drops below WCAG AA (4.5:1),
// so a palette tweak that makes something unreadable breaks the build instead
// of shipping.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(join(root, "design/tokens.json"), "utf8"));
const check = process.argv.includes("--check");

const WEB_OUT = join(root, "web/src/app/tokens.css");
const CLI_OUT = join(root, "apps/cli/packages/cli/src/ui/themes/lal-palette.ts");
// Raw values for code that cannot read CSS variables (canvas charts, SVG
// attributes, the manifest/viewport theme color).
const WEB_TS_OUT = join(root, "web/src/lib/design-tokens.ts");

// ---- contrast gate -------------------------------------------------------
function luminance(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const s = tokens.color.semantic;
const d = tokens.cli.dark;
const l = tokens.cli.light;
const pairs = [
  ...["primary", "secondary", "muted", "accent"].flatMap((t) =>
    ["canvas", "sidebar", "panel", "panelRaised"].map((b) => [`text.${t} on bg.${b}`, s.text[t], s.bg[b]])),
  ["text.secondary on bg.interactive", s.text.secondary, s.bg.interactive],
  ["text.accent on bg.selected", s.text.accent, s.bg.selected],
  ["text.inverse on text.accent (primary button)", s.text.inverse, s.text.accent],
  ...["success", "warning", "error", "info", "active"].map((k) => [`status.${k} on status.${k}Bg`, s.status[k], s.status[`${k}Bg`]]),
  ...Object.entries({ dark: d, light: l }).flatMap(([name, t]) =>
    ["Foreground", "Gray", "Comment", "LightBlue", "AccentBlue", "AccentPurple", "AccentCyan", "AccentGreen", "AccentYellow", "AccentRed"].flatMap((k) => [
      [`cli.${name}.${k} on Background`, t[k], t.Background],
      [`cli.${name}.${k} on DiffAdded`, t[k], t.DiffAdded],
    ])),
];
const failures = pairs.filter(([, fg, bg]) => contrast(fg, bg) < 4.5);
if (failures.length) {
  for (const [name, fg, bg] of failures) console.error(`contrast ${contrast(fg, bg).toFixed(2)} < 4.5  ${name} (${fg} on ${bg})`);
  process.exit(1);
}

// ---- web -----------------------------------------------------------------
const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const lines = [];
const decl = (name, value) => lines.push(`  --${name}: ${value};`);

for (const [k, v] of Object.entries(s.bg)) decl(`bg-${kebab(k)}`, v);
for (const [k, v] of Object.entries(s.text)) decl(`text-${kebab(k)}`, v);
for (const [k, v] of Object.entries(s.border)) decl(`border-${kebab(k)}`, v);
for (const [k, v] of Object.entries(s.status)) decl(`status-${kebab(k)}`, v);
s.chart.forEach((v, i) => decl(`chart-${i + 1}`, v));
for (const [k, v] of Object.entries(s.brand)) decl(`brand-${k}`, v);
for (const [k, v] of Object.entries(tokens.gradient)) decl(`gradient-${k}`, v);
decl("font-sans", tokens.typography.fontFamily.sans);
decl("font-mono", tokens.typography.fontFamily.mono);
for (const [k, v] of Object.entries(tokens.typography.fontSize)) decl(`fs-${k}`, v);
for (const [k, v] of Object.entries(tokens.typography.lineHeight)) decl(`lh-${k}`, v);
for (const [k, v] of Object.entries(tokens.typography.letterSpacing)) decl(`ls-${k}`, v);
for (const [k, v] of Object.entries(tokens.spacing)) decl(`space-${k}`, v);
for (const [k, v] of Object.entries(tokens.radius)) decl(`radius-${k}`, v);
for (const [k, v] of Object.entries(tokens.shadow)) decl(`shadow-${k}`, v);
for (const [k, v] of Object.entries(tokens.motion.duration)) decl(`dur-${k}`, v);
for (const [k, v] of Object.entries(tokens.motion.easing)) decl(`ease-${k}`, v);
for (const [k, v] of Object.entries(tokens.layout)) decl(kebab(k), v);

// Pre-token variable names used ~1,900 times across web/src. They stay as
// aliases so every page re-themes at once; new code should use the names above.
const legacy = {
  bg: "bg-canvas", "surface-1": "bg-panel", "surface-2": "bg-panel-raised", "surface-3": "bg-interactive", panel: "bg-panel",
  border: "border-default", "border-soft": "border-subtle", "border-loud": "border-focus",
  text: "text-primary", "text-1": "text-primary", "text-2": "text-secondary", "text-3": "text-muted", muted: "text-muted",
  accent: "text-accent", "accent-ai": "text-accent", "accent-wa": "text-accent", "on-accent": "text-inverse",
  "accent-info": "status-info", "accent-warn": "status-warning", "accent-danger": "status-error",
  "accent-success": "status-success", "accent-highlight": "text-accent",
  "r-sm": "radius-sm", "r-md": "radius-md", "r-lg": "radius-lg", "r-full": "radius-pill",
  "font-display": "font-sans", "font-body": "font-sans", "font-data": "font-mono", mono: "font-mono",
  "shadow-bubble": "shadow-raised",
};
lines.push("", "  /* legacy aliases */");
for (const [from, to] of Object.entries(legacy)) decl(from, `var(--${to})`);

// Tailwind v4 theme bridge: `bg-panel`, `text-muted`, `border-subtle`,
// `rounded-lg`, `font-sans` resolve to the tokens.
const theme = [];
for (const k of Object.keys(s.bg)) theme.push(`  --color-${kebab(k)}: var(--bg-${kebab(k)});`);
for (const k of ["primary", "secondary", "muted", "inverse", "accent"]) theme.push(`  --color-fg-${k}: var(--text-${k});`);
for (const k of Object.keys(s.border)) theme.push(`  --color-line-${k}: var(--border-${k});`);
for (const k of Object.keys(s.status)) theme.push(`  --color-${kebab(k)}: var(--status-${kebab(k)});`);
for (const k of Object.keys(tokens.radius)) theme.push(`  --radius-${k}: ${tokens.radius[k]};`);
theme.push(`  --font-sans: ${tokens.typography.fontFamily.sans};`, `  --font-mono: ${tokens.typography.fontFamily.mono};`);

const css = `/* GENERATED by scripts/build-design-tokens.mjs from design/tokens.json. Do not edit by hand. */
:root {
${lines.join("\n")}
  color-scheme: dark;
}

@theme inline {
${theme.join("\n")}
}
`;

// ---- cli -----------------------------------------------------------------
const tsObj = (o) => JSON.stringify(o, null, 2).replace(/"([A-Za-z]+)":/g, "$1:").replace(/"/g, "'");
const ts = `/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

// GENERATED by scripts/build-design-tokens.mjs from design/tokens.json.
// Do not edit by hand: change the JSON and run \`npm run tokens\`.

export const LAL_PALETTE_DARK = ${tsObj(d)} as const;

export const LAL_PALETTE_LIGHT = ${tsObj(l)} as const;

export const LAL_BRAND = ${tsObj(tokens.cli.brand)} as const;
`;

const webTs = `// GENERATED by scripts/build-design-tokens.mjs from design/tokens.json. Do not edit by hand.
// Prefer CSS variables (var(--text-muted)) in markup; use these only where CSS
// variables cannot reach — canvas drawing, the web manifest, viewport metadata.
export const TOKENS = ${JSON.stringify({ bg: s.bg, text: s.text, border: s.border, status: s.status, chart: s.chart, brand: s.brand, font: tokens.typography.fontFamily }, null, 2)} as const;
`;

let stale = false;
for (const [path, content] of [[WEB_OUT, css], [CLI_OUT, ts], [WEB_TS_OUT, webTs]]) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current === content) continue;
  if (check) { console.error(`stale: ${path} (run npm run tokens)`); stale = true; }
  else { writeFileSync(path, content); console.log(`wrote ${path}`); }
}
if (stale) process.exit(1);
console.log(`tokens ok — ${pairs.length} contrast pairs >= 4.5:1`);
