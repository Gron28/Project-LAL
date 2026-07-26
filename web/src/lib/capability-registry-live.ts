/** Runtime wiring for the pure registry schema/repository. */
import path from "node:path";
import { allModels } from "./lab";
import { resolvePlatformDirectories } from "./host-profile";
import { listModelProfiles } from "./hive/store";
import { CapabilityRegistryRepository, type RegistryInventoryItem } from "./capability-registry";

export function discoverExistingModelInventory(): RegistryInventoryItem[] {
  return allModels().map((model) => ({ name: model.name, source: model.source, path: model.path, sizeBytes: Math.round(model.gb * 1e9) }));
}

export function defaultCapabilityRegistryPath(): string {
  return path.join(resolvePlatformDirectories().state, "registry", "capability-registry-v1.json");
}

/** The only refresh wiring; it scans existing files and HIVE records without writes to model sources. */
export async function refreshLiveCapabilityRegistry() {
  return new CapabilityRegistryRepository(defaultCapabilityRegistryPath()).refresh(discoverExistingModelInventory(), listModelProfiles());
}

/** Fast compatibility read for existing selectors; the dedicated API refreshes discovery. */
export async function readOrRefreshLiveCapabilityRegistry() {
  const repository = new CapabilityRegistryRepository(defaultCapabilityRegistryPath());
  return repository.read() ?? repository.refresh(discoverExistingModelInventory(), listModelProfiles());
}
