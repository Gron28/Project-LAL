/**
 * Egress policy applied by the supported `lal` package entrypoint.
 *
 * The inherited CLI can schedule an upstream update check when it is not
 * managed by a distribution wrapper.  LAL is always such a wrapper: updates
 * use the explicit LAL release path instead.  Set the marker unconditionally
 * so a caller cannot weaken that boundary with a pre-existing environment
 * value.
 */
export const LAL_MANAGED_ENV = 'LAL_MANAGED';
export const LAL_MANAGED_VALUE = '1';

/**
 * Apply the process-level boundary before loading any CLI code.
 *
 * `env` is injectable for a deterministic, network-free acceptance check.
 */
export function applyLalManagedRuntimePolicy(env = process.env) {
  env[LAL_MANAGED_ENV] = LAL_MANAGED_VALUE;
}

/**
 * The default egress posture for the supported `lal` entrypoint.
 *
 * This intentionally captures only inherited startup paths. Explicit LAL
 * commands and operator-configured provider endpoints have their own policy
 * entries in provenance/outbound-inventory.json.
 */
export function defaultLalStartupEgress() {
  return Object.freeze({
    inheritedRum: false,
    inheritedUpdateCheck: false,
  });
}
