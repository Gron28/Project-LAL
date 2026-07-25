/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Acceptance criteria — PLAN Stage 6, "the runtime decides completion".
 *
 * A model's completion claim is a proposal that enters validation; it is never
 * the terminal state. The generalisation the plan asks for is that *every*
 * workflow type declares criteria the runtime can check, so this is a registry
 * of checks rather than a website-specific hook: `applies()` decides whether a
 * check has anything to say about the artifact, `check()` produces findings.
 *
 * The hard constraint on every check: it reports only what it actually verified.
 * A check that cannot inspect something lists it under `unchecked` instead of
 * passing it silently, because a validator that reports success for work it never
 * looked at is worse than no validator — it converts an unknown into a false
 * assurance (PLAN rule 7).
 */

export type AcceptanceSeverity =
  /** The artifact is broken. Completion must not be claimed. */
  | 'fatal'
  /** Probably wrong and worth repairing, but not proof of breakage. */
  | 'warning';

export interface AcceptanceFinding {
  severity: AcceptanceSeverity;
  /** Stable machine id, e.g. `js-syntax-error`. */
  code: string;
  /** One line, addressed to whoever has to fix it. */
  message: string;
  /** 1-based line in the artifact, when known. */
  line?: number;
}

export interface AcceptanceReport {
  /** The check that produced this. */
  criteria: string;
  /** Absolute path of the artifact examined. */
  artifact: string;
  findings: AcceptanceFinding[];
  /**
   * Properties this check could NOT verify, in plain words. Surfaced to the
   * model and the operator so "validated" is never read as "fully validated".
   */
  unchecked: string[];
}

export interface AcceptanceCriteria {
  /** Stable id, used in messages and to de-duplicate registrations. */
  readonly id: string;
  /** Does this criteria have anything to say about this artifact? */
  applies(artifactPath: string): boolean;
  /** Inspect the artifact. Must never throw; an internal failure is a finding. */
  check(artifactPath: string, content: string): Promise<AcceptanceReport>;
}

export function hasFatal(reports: readonly AcceptanceReport[]): boolean {
  return reports.some((r) => r.findings.some((f) => f.severity === 'fatal'));
}

/**
 * Render reports as the message handed back to the model. Fatal findings lead,
 * because the model acts on the first thing it reads, and the unchecked list is
 * always included — an honest validator says what it did not look at.
 */
export function formatAcceptanceReports(
  reports: readonly AcceptanceReport[],
): string {
  const fatal = reports.flatMap((r) =>
    r.findings.filter((f) => f.severity === 'fatal').map((f) => ({ r, f })),
  );
  const warnings = reports.flatMap((r) =>
    r.findings.filter((f) => f.severity === 'warning').map((f) => ({ r, f })),
  );
  const lines: string[] = [];
  const render = ({ r, f }: { r: AcceptanceReport; f: AcceptanceFinding }) =>
    `- ${r.artifact}${f.line ? `:${f.line}` : ''} — [${f.code}] ${f.message}`;

  if (fatal.length) {
    lines.push(
      `The runtime validated the work and it is NOT complete. ${fatal.length} defect(s) that break the artifact:`,
      ...fatal.map(render),
    );
  } else {
    lines.push('The runtime validated the work. No breaking defects were found.');
  }
  if (warnings.length) {
    lines.push('', `${warnings.length} likely problem(s):`, ...warnings.map(render));
  }
  const unchecked = [...new Set(reports.flatMap((r) => r.unchecked))];
  if (unchecked.length) {
    lines.push(
      '',
      'NOT verified by this check (do not report these as validated):',
      ...unchecked.map((u) => `- ${u}`),
    );
  }
  if (fatal.length) {
    lines.push(
      '',
      'Fix every defect above, then say what you changed. Do not claim the work is',
      'finished while any of them stands. If a defect is a false positive, say which',
      'and why — do not silently ignore it.',
    );
  }
  return lines.join('\n');
}
