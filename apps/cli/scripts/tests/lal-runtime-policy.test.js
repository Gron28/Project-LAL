// Was written against node:test, but this directory is collected by vitest,
// which does not recognise node:test suites — so the whole file reported "No
// test suite found" and these assertions never ran. Converted to vitest so the
// egress deny-by-default policy is actually enforced by the suite.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  applyLalManagedRuntimePolicy,
  defaultLalStartupEgress,
  LAL_MANAGED_ENV,
  LAL_MANAGED_VALUE,
} from '../lal-runtime-policy.mjs';

test('forces the managed marker even when the caller supplies an unmanaged value', () => {
  const environment = { [LAL_MANAGED_ENV]: '0' };

  applyLalManagedRuntimePolicy(environment);

  assert.equal(environment[LAL_MANAGED_ENV], LAL_MANAGED_VALUE);
});

test('keeps inherited startup egress deny-by-default', () => {
  assert.deepEqual(defaultLalStartupEgress(), {
    inheritedRum: false,
    inheritedUpdateCheck: false,
  });
});
