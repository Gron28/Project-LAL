/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import type { AcceptanceCriteria, AcceptanceReport } from './types.js';
import { webArtifactAcceptance } from './html-acceptance.js';

export * from './types.js';
export * from './html-acceptance.js';

/**
 * The registry. Stage 6 generalises to "every workflow type declares acceptance
 * criteria the runtime can check", so adding a workflow means adding a criteria
 * here — not another completion hook in the turn loop.
 */
const registry: AcceptanceCriteria[] = [webArtifactAcceptance];

export function registerAcceptanceCriteria(criteria: AcceptanceCriteria): void {
  const existing = registry.findIndex((c) => c.id === criteria.id);
  if (existing >= 0) registry[existing] = criteria;
  else registry.push(criteria);
}

export function acceptanceCriteriaFor(artifactPath: string): AcceptanceCriteria[] {
  return registry.filter((c) => c.applies(artifactPath));
}

/**
 * Validate artifacts by reading them from disk — the state that matters is what
 * was written, not what the model said it wrote. A path with no applicable
 * criteria yields no report, which is honest silence rather than a fabricated
 * pass.
 */
export async function validateArtifacts(
  artifactPaths: readonly string[],
): Promise<AcceptanceReport[]> {
  const reports: AcceptanceReport[] = [];
  for (const artifactPath of new Set(artifactPaths)) {
    const criteria = acceptanceCriteriaFor(artifactPath);
    if (criteria.length === 0) continue;
    let content: string;
    try {
      content = fs.readFileSync(artifactPath, 'utf8');
    } catch {
      // The file the model claims to have produced is not readable. That is
      // itself the most important possible finding.
      reports.push({
        criteria: 'existence',
        artifact: artifactPath,
        findings: [
          {
            severity: 'fatal',
            code: 'artifact-missing',
            message: 'the file does not exist or cannot be read',
          },
        ],
        unchecked: [],
      });
      continue;
    }
    for (const c of criteria) reports.push(await c.check(artifactPath, content));
  }
  return reports;
}
