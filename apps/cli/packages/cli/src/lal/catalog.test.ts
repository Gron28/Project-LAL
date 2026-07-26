/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { parseReadonlyCapabilityCatalog, resolveCatalogAlias } from './catalog.js';

const digest = 'a'.repeat(64);
const catalog = {
  schemaVersion: 1,
  apiVersion: 'v1',
  models: [{ id: `model:sha256:${digest}`, artifactId: `artifact:sha256:${digest}`, runtimeIds: [`runtime:sha256:${digest}`], aliases: ['local:demo'], displayName: 'demo', installed: true }],
};

describe('read-only capability catalog', () => {
  it('resolves legacy aliases to immutable model records', () => {
    const parsed = parseReadonlyCapabilityCatalog(catalog);
    expect(resolveCatalogAlias(parsed, 'local:demo')?.artifactId).toBe(`artifact:sha256:${digest}`);
  });

  it('fails closed on an invalid artifact identity', () => {
    expect(() => parseReadonlyCapabilityCatalog({ ...catalog, models: [{ ...catalog.models[0], artifactId: 'artifact:sha256:not-a-digest' }] })).toThrow(/invalid capability registry model/);
  });
});
