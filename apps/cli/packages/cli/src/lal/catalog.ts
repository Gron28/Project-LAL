/**
 * Read-only compatibility contract for the host capability registry.
 * The terminal never interprets a mutable model alias as an artifact identity
 * and this module intentionally contains no network or download operation.
 */
export const CAPABILITY_REGISTRY_API_VERSION = 'v1';

export type CatalogModel = Readonly<{
  id: `model:sha256:${string}`;
  artifactId: `artifact:sha256:${string}`;
  runtimeIds: readonly `runtime:sha256:${string}`[];
  aliases: readonly string[];
  displayName: string;
  installed: true;
}>;

export type ReadonlyCapabilityCatalog = Readonly<{
  schemaVersion: 1;
  apiVersion: typeof CAPABILITY_REGISTRY_API_VERSION;
  models: readonly CatalogModel[];
}>;

const digest = /^[a-f0-9]{64}$/i;
const artifactId = /^artifact:sha256:([a-f0-9]{64})$/i;
const modelId = /^model:sha256:([a-f0-9]{64})$/i;
const runtimeId = /^runtime:sha256:([a-f0-9]{64})$/i;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate untrusted host JSON before it is rendered or used by terminal UX. */
export function parseReadonlyCapabilityCatalog(value: unknown): ReadonlyCapabilityCatalog {
  if (!isObject(value) || value['schemaVersion'] !== 1 || value['apiVersion'] !== CAPABILITY_REGISTRY_API_VERSION || !Array.isArray(value['models'])) {
    throw new Error('unsupported capability registry catalog');
  }
  const models = value['models'].map((raw, index): CatalogModel => {
    if (!isObject(raw) || typeof raw['id'] !== 'string' || !modelId.test(raw['id']) || typeof raw['artifactId'] !== 'string' || !artifactId.test(raw['artifactId'])
      || typeof raw['displayName'] !== 'string' || !raw['displayName'].trim() || raw['installed'] !== true || !Array.isArray(raw['aliases']) || !raw['aliases'].every((alias) => typeof alias === 'string' && alias.includes(':'))
      || !Array.isArray(raw['runtimeIds']) || !raw['runtimeIds'].every((id) => typeof id === 'string' && runtimeId.test(id))) {
      throw new Error(`invalid capability registry model at index ${index}`);
    }
    // IDs must really contain a byte digest even when a permissive RegExp is
    // changed later; this keeps the terminal's trust boundary obvious.
    if (!digest.test(raw['id'].slice(-64)) || !digest.test(raw['artifactId'].slice(-64))) throw new Error(`invalid capability registry digest at index ${index}`);
    return { id: raw['id'] as CatalogModel['id'], artifactId: raw['artifactId'] as CatalogModel['artifactId'], runtimeIds: raw['runtimeIds'] as CatalogModel['runtimeIds'], aliases: [...new Set(raw['aliases'])].sort(), displayName: raw['displayName'], installed: true };
  });
  return { schemaVersion: 1, apiVersion: CAPABILITY_REGISTRY_API_VERSION, models };
}

/** Compatibility aliases are lookup keys only; returned IDs remain immutable. */
export function resolveCatalogAlias(catalog: ReadonlyCapabilityCatalog, alias: string): CatalogModel | undefined {
  return catalog.models.find((model) => model.aliases.includes(alias));
}
