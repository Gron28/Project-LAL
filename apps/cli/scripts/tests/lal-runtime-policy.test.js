import assert from 'node:assert/strict';
import test from 'node:test';
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
