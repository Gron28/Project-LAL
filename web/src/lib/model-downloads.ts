import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePlatformDirectories, resolvePlatformDirectories } from "./host-profile.ts";
import { getJobRepository, type Job, type JobRepository } from "./jobs.ts";
import { downloadHuggingFacePlan, type AcquisitionFetch, type ImportRecord, type ResolutionPlan, VerifiedModelImportStore } from "./model-acquisition.ts";

export type ModelDownloadRequest = { plan: ResolutionPlan; modelName: string; requestedBy: string };
export type ModelDownloadExecution = { job: Job; import: ImportRecord; activated?: { name: string; path: string; artifactId: string } };

function freeBytes(directory: string): number {
  const stat = fs.statfsSync(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}
function modelDirectories() {
  const directories = ensurePlatformDirectories(resolvePlatformDirectories());
  return { imports: path.join(directories.cache, "model-acquisitions"), models: path.join(directories.data, "models"), data: directories.data };
}
async function refreshRegistryAfterImport(): Promise<unknown> {
  return (await import("./capability-registry-live.ts")).refreshLiveCapabilityRegistry();
}

/** The durable job owns progress/cancellation; the import store owns bytes. */
export async function executeModelDownload(input: {
  repository: JobRepository; jobId: string; request: ModelDownloadRequest; store: VerifiedModelImportStore;
  modelDirectory: string; availableDiskBytes: number; fetchImpl?: AcquisitionFetch; refreshRegistry?: () => Promise<unknown>;
}): Promise<ModelDownloadExecution> {
  const started = input.repository.start(input.jobId);
  if (!started.started) throw new Error(`model download could not start: ${started.reason}`);
  try {
    const record = await downloadHuggingFacePlan({
      plan: input.request.plan, store: input.store, importId: input.jobId, availableDiskBytes: input.availableDiskBytes, fetchImpl: input.fetchImpl,
      cancelled: () => !!input.repository.get(input.jobId)?.cancelRequestedAt,
      onProgress: (progress) => input.repository.checkpoint(input.jobId, { importId: input.jobId, receivedBytes: progress.receivedBytes }, { phase: "downloading", completed: progress.receivedBytes, total: progress.plan.file.sizeBytes }),
      onVerifying: () => input.repository.checkpoint(input.jobId, { importId: input.jobId, receivedBytes: input.request.plan.file.sizeBytes }, { phase: "verifying sha256", completed: input.request.plan.file.sizeBytes, total: input.request.plan.file.sizeBytes }),
    });
    if (record.state === "cancelled") return { job: input.repository.cancelSettled(input.jobId), import: record };
    if (record.state !== "verified") throw new Error(record.error || "model bytes could not be verified");
    const activated = input.store.activateGguf(input.jobId, input.request.modelName, input.modelDirectory);
    input.repository.checkpoint(
      input.jobId,
      {
        importId: input.jobId,
        receivedBytes: input.request.plan.file.sizeBytes,
        modelName: input.request.modelName,
        artifactId: activated.artifactId,
      },
      {
        phase: "indexing verified model",
        completed: input.request.plan.file.sizeBytes,
        total: input.request.plan.file.sizeBytes,
      },
    );
    await (input.refreshRegistry ?? refreshRegistryAfterImport)();
    const job = input.repository.succeed(input.jobId, [{ id: activated.artifactId, digest: record.plan.file.sha256 }]);
    return { job, import: record, activated };
  } catch (error) {
    input.store.discard(
      input.jobId,
      error instanceof Error ? error.message : String(error),
    );
    const current = input.repository.get(input.jobId);
    if (current?.state === "running") input.repository.fail(input.jobId, { code: "model_download_failed", message: (error as Error).message, retryable: false });
    throw error;
  }
}

type DownloadGlobal = typeof globalThis & { __lal_model_downloads?: Map<string, Promise<ModelDownloadExecution>>; __lal_model_downloads_recovered?: boolean };

export function recoverModelDownloadJobs(): void {
  const global = globalThis as DownloadGlobal;
  if (global.__lal_model_downloads_recovered) return;
  const repository = getJobRepository(), dirs = modelDirectories();
  const recovered = repository.recover("model.download");
  global.__lal_model_downloads_recovered = true;
  for (const id of recovered.queued) {
    repository.fail(id, {
      code: "model_download_restart_required",
      message: "host restarted; restart this download to obtain a fresh verified transfer",
      retryable: true,
    });
  }
  const discarded = [...recovered.interrupted, ...recovered.queued];
  if (!discarded.length) return;
  const store = new VerifiedModelImportStore(dirs.imports);
  for (const id of discarded) store.discard(id, "host restarted before byte verification completed");
}
/** Start only after the browser has selected a pinned plan. The promise is kept
 * in process memory for this worker; durable state remains in the job/import
 * stores for inspection if the host restarts. */
export function requestModelDownload(request: ModelDownloadRequest): Job {
  recoverModelDownloadJobs();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(request.modelName)) throw new Error("model name must be a safe identifier");
  const repository = getJobRepository();
  const jobId = `model-download-${crypto.randomUUID()}`;
  const dirs = modelDirectories(); const store = new VerifiedModelImportStore(dirs.imports);
  const job = repository.create({ id: jobId, kind: "model.download", requestedBy: request.requestedBy || "local-browser", capabilityScope: ["model.download"], resources: { network: true, diskBytes: request.plan.requiredDiskBytes, cpuSlots: 1 }, restartPolicy: "none", checkpoint: { plan: request.plan, modelName: request.modelName, importId: jobId }, inputs: [], retentionClass: "model-acquisition" });
  const global = globalThis as DownloadGlobal; const active = global.__lal_model_downloads ?? new Map<string, Promise<ModelDownloadExecution>>(); global.__lal_model_downloads = active;
  const promise = executeModelDownload({ repository, jobId, request, store, modelDirectory: dirs.models, availableDiskBytes: freeBytes(dirs.data) })
    .finally(() => active.delete(jobId));
  active.set(jobId, promise);
  // Errors are captured in the durable job state; avoid an unhandled rejection
  // from an HTTP handler after its accepted response has returned.
  void promise.catch(() => undefined);
  return job;
}

export function cancelModelDownload(jobId: string): Job | null {
  const job = getJobRepository().get(jobId);
  if (!job || job.kind !== "model.download") return null;
  return getJobRepository().requestCancel(jobId);
}

/** Useful for UI preflight displays; physical free space is measured now. */
export function currentModelDownloadHostEstimate() {
  const dirs = modelDirectories();
  return { availableDiskBytes: freeBytes(dirs.data), availableRamBytes: os.totalmem() };
}
