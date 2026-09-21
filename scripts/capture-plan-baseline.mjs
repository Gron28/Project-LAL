#!/usr/bin/env node

// Capture the repository and runtime inputs that make an experiment plan
// reproducible (schema v2; see VERSION below). By default this still records
// metadata and hashes only for the repository tree itself: the untracked
// path inventory never opens an untracked file unless --with-untracked-content
// is passed, and a model weight is identified by path/size/mtime, never
// hashed, unless --hash-model-artifact is passed. Schema v2 adds read-only,
// cheap-by-default CLI bundle, model-profile, backend, hardware, and
// workspace identity (ACCEPTANCE.md Gate 1 §2); see cliIdentity(),
// modelIdentity(), backendVersions(), hardwareIdentity(), and
// workspaceIdentity() below for exactly what each section does and does not
// establish.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCHEMA = "local-ai-lab.experiment-baseline";
// v1 recorded git/file/runtime metadata and hashes only (ACCEPTANCE.md Gate 1
// found this insufficient: "a hash is not a backup", and no model/CLI/hardware
// identity was captured at all). v2 is additive: every v1 field keeps its
// exact shape and meaning, and the new sections below are appended alongside
// them. validateBaseline() below still recognizes version 1 artifacts (e.g.
// benchmarks/baselines/2026-09-18-native-cli-contract-v1.json) against the
// original v1 shape, so existing frozen baselines remain readable; only new
// captures are stamped v2.
export const VERSION = 2;
const LEGACY_VERSION = 1;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// This is an allow-list on purpose.  Do not broaden it to .env files or an
// arbitrary config glob: a baseline must not accidentally read credentials.
export const KEY_FILES = [
  "apps/cli/package-lock.json",
  "apps/cli/package.json",
  "apps/cli/tsconfig.json",
  "docs/PLAN.md",
  "llama/src/pyproject.toml",
  "llama/src/requirements.txt",
  "package-lock.json",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "web-b/package-lock.json",
  "web-b/package.json",
  "web-b/tsconfig.json",
  "web/package-lock.json",
  "web/package.json",
  "web/tsconfig.json",
].sort();

// Defense-in-depth mirroring the .gitignore fix for the same trees (worker H,
// defect 3): even if .gitignore is ever wrong or bypassed, the untracked
// content coverage below must never descend into a second copy of the web
// app, a git worktree, or an unrelated scraping task's scratch files.
const EXCLUDED_UNTRACKED_PREFIXES = [
  "web-b/",
  ".worktrees/",
  "storage/",
  "node_modules/",
  ".next/",
];
const EXCLUDED_UNTRACKED_NAME_PATTERN = /^\.?tmp-.*\.(ts|js|mjs)$/i;

// Untracked CONTENT is only ever read for paths under these prefixes, and
// only when a caller explicitly opts in (captureBaseline's
// `includeUntrackedContent` / `--with-untracked-content`). This mirrors the
// KEY_FILES allow-list discipline: broadening this to "every untracked path"
// (an implicit `-A`) is exactly the mistake Gate 1 and this repo's own
// .gitignore incident warn against.
const UNTRACKED_CONTENT_INCLUDE_PREFIXES = [
  "scripts/",
  "docs/",
  "benchmarks/",
  "data/",
  "apps/cli/packages/",
  "apps/cli/scripts/",
  "web/src/",
  "web/public/",
];

// Even inside an included prefix, never read a file whose name looks like a
// credential. This is a second, independent gate: it does not rely on the
// include-list author having remembered to keep secrets out of scripts/,
// web/src/, etc.
const SECRET_LIKE_NAME_PATTERN =
  /(^|[/\\])\.env(\..*)?$|\.pem$|\.key$|id_(ed25519|rsa)(\.pub)?$|secret|credential|token/i;

const UNTRACKED_CONTENT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const UNTRACKED_CONTENT_MAX_FILES = 4000;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: null,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function gitHead(root) {
  const output = runGit(root, ["rev-parse", "HEAD"]);
  return output ? output.toString("utf8").trim() || null : null;
}

function trackedDiff(root) {
  const output = runGit(root, ["diff", "--binary", "HEAD", "--"]);
  return output
    ? { bytes: output, available: true }
    : { bytes: Buffer.alloc(0), available: false };
}

function untrackedPaths(root) {
  const output = runGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!output) return { paths: [], available: false };
  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      paths.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  // git normally sorts this output, but sorting explicitly makes the hash
  // independent of git configuration and implementation details.
  paths.sort(Buffer.compare);
  return { paths, available: true };
}

function fileHashes(root) {
  return Object.fromEntries(
    KEY_FILES.map((relativePath) => {
      const absolutePath = path.join(root, relativePath);
      try {
        const stat = fs.lstatSync(absolutePath);
        // A symlink could redirect a seemingly harmless allow-listed path to a
        // secret.  Report it as unavailable rather than following it.
        if (!stat.isFile()) return [relativePath, null];
        return [relativePath, sha256(fs.readFileSync(absolutePath))];
      } catch {
        return [relativePath, null];
      }
    }),
  );
}

function readJsonSafe(absolutePath) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextSafe(absolutePath) {
  try {
    return fs.readFileSync(absolutePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function statSafe(absolutePath) {
  try {
    const stat = fs.lstatSync(absolutePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function anyFileNewerThan(dirs, referenceFile) {
  const existingDirs = dirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (!existingDirs.length) return false;
  try {
    const output = execFileSync(
      "find",
      [...existingDirs, "-type", "f", "-newer", referenceFile, "-print", "-quit"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
    return output.trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * The identity of the CLI bundle that `~/.local/bin/lal` actually executes.
 * ACCEPTANCE.md Gate 1 §2 requires "executable path/hash"; the prior capture
 * recorded neither. Everything here is a stat/read of files already produced
 * by a build that may or may not have happened -- nothing is built here.
 */
function cliIdentity(root) {
  const bundlePath = path.join(root, "apps/cli/dist/cli.js");
  const bundleStat = statSafe(bundlePath);
  const packageJsonPath = path.join(root, "apps/cli/package.json");
  const packageJson = readJsonSafe(packageJsonPath);
  const generatedCommitPath = path.join(
    root,
    "apps/cli/packages/cli/src/generated/git-commit.ts",
  );
  const generatedText = readTextSafe(generatedCommitPath);
  const embeddedGitCommit = generatedText
    ? (generatedText.match(/GIT_COMMIT_INFO\s*=\s*'([^']*)'/) ?? [])[1] ?? null
    : null;
  const embeddedVersion = generatedText
    ? (generatedText.match(/CLI_VERSION\s*=\s*'([^']*)'/) ?? [])[1] ?? null
    : null;
  const homeDir = os.homedir();
  const installedEntrypoint = path.join(homeDir, ".local/bin/lal");
  let installedEntrypointTarget = null;
  try {
    installedEntrypointTarget = fs.realpathSync(installedEntrypoint);
  } catch {
    installedEntrypointTarget = null;
  }
  const bundleStaleRelativeToSource = bundleStat
    ? anyFileNewerThan(
        [
          path.join(root, "apps/cli/packages/core/src"),
          path.join(root, "apps/cli/packages/cli/src"),
          path.join(root, "apps/cli/scripts"),
        ],
        bundlePath,
      ) ||
      (statSafe(packageJsonPath)?.mtimeMs ?? 0) > bundleStat.mtimeMs
    : null;
  return {
    installedEntrypoint: fs.existsSync(installedEntrypoint)
      ? installedEntrypoint
      : null,
    installedEntrypointTarget,
    bundlePath: bundleStat ? bundlePath : null,
    bundleSha256: bundleStat ? sha256(fs.readFileSync(bundlePath)) : null,
    bundleMtimeMs: bundleStat ? bundleStat.mtimeMs : null,
    bundleUnavailableReason: bundleStat
      ? null
      : "apps/cli/dist/cli.js not found -- the CLI has not been built in this tree",
    packageVersion: packageJson?.version ?? null,
    embeddedGitCommit,
    embeddedVersion,
    bundleStaleRelativeToSource,
    bundleStaleUnavailableReason: bundleStat
      ? null
      : "cannot assess staleness without a built bundle to compare mtimes against",
  };
}

/**
 * Configured model profile + backend identity, read from the CLI's own local
 * settings (never from a .env or credential file). `envKey` is a field NAME
 * naming which environment variable holds the token -- never the token value
 * itself -- and is deliberately not copied here regardless.
 */
function modelIdentity(root, { hashModelArtifact = false } = {}) {
  const lalHome = process.env.LAL_HOME || path.join(os.homedir(), ".lal");
  const settings = readJsonSafe(path.join(lalHome, "settings.json"));
  const configuredProfileId = settings?.model?.name ?? null;
  const providers = settings?.modelProviders?.openai;
  const provider = Array.isArray(providers)
    ? providers.find((entry) => entry?.id === configuredProfileId)
    : null;
  const contextProfile = provider?.generationConfig?.contextProfile ?? null;
  const profile = provider
    ? {
        id: provider.id ?? null,
        backend: contextProfile?.backend ?? null,
        baseUrl: provider.baseUrl ?? null,
        contextWindowSize: provider.generationConfig?.contextWindowSize ?? null,
        contextProfileFingerprint: contextProfile?.fingerprint ?? null,
        // The client's own settings already call this field "unknown" when
        // it has not independently checked the backend; carry that caveat
        // through rather than presenting the fingerprint as verified.
        contextProfileVerification: contextProfile?.verification ?? null,
        contextProfileSource: contextProfile?.source ?? null,
        samplingParams: provider.generationConfig?.samplingParams ?? null,
        chatTemplateKwargs:
          provider.generationConfig?.extra_body?.chat_template_kwargs ?? null,
      }
    : null;
  const modelsDir = path.join(root, "models");
  let artifactCandidates = [];
  if (configuredProfileId) {
    try {
      const needle = String(configuredProfileId).toLowerCase();
      artifactCandidates = fs
        .readdirSync(modelsDir)
        .filter(
          (name) =>
            name.toLowerCase().startsWith(needle) &&
            name.toLowerCase().endsWith(".gguf"),
        )
        .sort();
    } catch {
      artifactCandidates = [];
    }
  }
  const artifacts = artifactCandidates.map((name) => {
    const absolutePath = path.join(modelsDir, name);
    let stat = null;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      stat = null;
    }
    return {
      path: path.relative(root, absolutePath),
      sizeBytes: stat ? stat.size : null,
      mtimeMs: stat ? stat.mtimeMs : null,
      // Quantization is inferred from the filename convention used in this
      // tree (e.g. "-q4"), not verified from the GGUF header -- opening a
      // multi-GB weight's header is out of scope for a cheap capture.
      quantizationFromFilename: (name.match(/-(q[0-9][a-z0-9_]*)\b/i) ?? [])[1]
        ?.toLowerCase() ?? null,
      sha256: hashModelArtifact && stat ? sha256(fs.readFileSync(absolutePath)) : null,
      sha256UnavailableReason: hashModelArtifact
        ? stat
          ? null
          : "artifact file missing"
        : "hashing a multi-GB model weight is skipped by default for cost -- pass --hash-model-artifact to compute it",
    };
  });
  return {
    configuredProfileId,
    profile,
    profileUnavailableReason: provider
      ? null
      : configuredProfileId
        ? "configured profile id has no matching entry in modelProviders.openai"
        : "no LAL_HOME/settings.json model.name found",
    artifacts,
    artifactsUnavailableReason: artifacts.length
      ? null
      : "no models/*.gguf file name starts with the configured profile id",
  };
}

/**
 * Backend/runtime version identity. Only `--version`-style probes of
 * binaries that are already on disk; nothing is started or loaded.
 */
function backendVersions(root) {
  let llamaDirs = [];
  try {
    llamaDirs = fs
      .readdirSync(path.join(root, "llama"))
      .filter((name) => /^llama-b\d+/i.test(name))
      .sort();
  } catch {
    llamaDirs = [];
  }
  const llama = llamaDirs.map((dir) => {
    const binaryPath = path.join(root, "llama", dir, "llama-server");
    const exists = fs.existsSync(binaryPath);
    return {
      dir,
      path: exists ? binaryPath : null,
      version: exists ? commandVersion(binaryPath, ["--version"]) : null,
    };
  });
  return {
    llama,
    llamaUnavailableReason: llama.length
      ? null
      : "no llama/llama-b*/llama-server binary found in this tree",
    ollamaVersion: commandVersion("ollama", ["--version"]),
  };
}

/**
 * Static hardware/OS identity only -- never live utilization counters
 * (VRAM/RAM used, temperatures, busy%). Those change from one instant to the
 * next and would make captureBaseline() non-deterministic across two calls a
 * moment apart, which the existing determinism test (and Gate 1's own
 * "second checkout reproduces the recorded results" exit bar) both depend on.
 */
function hardwareIdentity() {
  const gpu = [];
  if (process.platform === "linux") {
    try {
      for (const name of fs
        .readdirSync("/sys/class/drm")
        .filter((entry) => /^card\d+$/.test(entry))) {
        const device = path.join("/sys/class/drm", name, "device");
        const read = (file) => readTextSafe(path.join(device, file));
        gpu.push({
          card: name,
          vendor: read("vendor"),
          device: read("device"),
          vramTotalBytes: read("mem_info_vram_total"),
        });
      }
    } catch {
      /* no /sys/class/drm on this platform/sandbox; leave gpu empty */
    }
  }
  return {
    cpuCount: os.cpus()?.length ?? null,
    ramTotalBytes: os.totalmem(),
    gpu,
  };
}

function isLoopbackHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return null;
  }
}

/**
 * Device/workspace identity written by the pairing/install flow under
 * LAL_HOME. These are small plain-text identity files (device id/name,
 * platform, the paired client-host URL) -- never `.env`/credentials.
 */
function workspaceIdentity() {
  const lalHome = process.env.LAL_HOME || path.join(os.homedir(), ".lal");
  const clientHost = readTextSafe(path.join(lalHome, "client-host"));
  return {
    lalHome,
    deviceId: readTextSafe(path.join(lalHome, "device-id")),
    deviceName: readTextSafe(path.join(lalHome, "device-name")),
    platform: readTextSafe(path.join(lalHome, "platform")),
    clientVersion: readTextSafe(path.join(lalHome, "client-version")),
    clientHost,
    topology: {
      clientHost,
      isLoopback: clientHost ? isLoopbackHost(clientHost) : null,
    },
  };
}

/**
 * Content-hash coverage for an explicit, narrow include-list of untracked
 * source (never `-A`). This is the one function in this file that reads
 * untracked file bytes, so every gate here is deliberate:
 *  - default OFF (`includeUntrackedContent` / `--with-untracked-content`):
 *    the existing "the untracked inventory never opens a file" invariant
 *    holds unless a human explicitly asks for more;
 *  - even when enabled, only paths under UNTRACKED_CONTENT_INCLUDE_PREFIXES
 *    are eligible, and SECRET_LIKE_NAME_PATTERN is checked independently of
 *    that allow-list;
 *  - EXCLUDED_UNTRACKED_PREFIXES/EXCLUDED_UNTRACKED_NAME_PATTERN keep the
 *    known large/unrelated trees (web-b/, .worktrees/, storage/, the tmp-*
 *    scraping scripts) out even if .gitignore were ever wrong;
 *  - a size cap and a file-count cap keep this cheap.
 */
function untrackedSourceContent(root, untrackedPathBuffers, { enabled }) {
  if (!enabled) {
    return {
      enabled: false,
      files: [],
      truncated: false,
      unavailableReason:
        "not requested; pass includeUntrackedContent / --with-untracked-content to hash the explicit include-list below",
      includePrefixes: UNTRACKED_CONTENT_INCLUDE_PREFIXES,
      excludedPrefixes: EXCLUDED_UNTRACKED_PREFIXES,
    };
  }
  const relativePaths = untrackedPathBuffers
    .map((buffer) => buffer.toString("utf8"))
    .filter((relativePath) => {
      const posixPath = relativePath.split(path.sep).join("/");
      if (EXCLUDED_UNTRACKED_PREFIXES.some((prefix) => posixPath.startsWith(prefix)))
        return false;
      if (EXCLUDED_UNTRACKED_NAME_PATTERN.test(path.basename(posixPath)))
        return false;
      if (SECRET_LIKE_NAME_PATTERN.test(posixPath)) return false;
      return UNTRACKED_CONTENT_INCLUDE_PREFIXES.some((prefix) =>
        posixPath.startsWith(prefix),
      );
    })
    .sort();
  const truncated = relativePaths.length > UNTRACKED_CONTENT_MAX_FILES;
  const selected = truncated
    ? relativePaths.slice(0, UNTRACKED_CONTENT_MAX_FILES)
    : relativePaths;
  const files = selected.map((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    let stat = null;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      return { path: relativePath, sizeBytes: null, sha256: null, skippedReason: "not a regular file" };
    }
    if (stat.size > UNTRACKED_CONTENT_MAX_FILE_BYTES) {
      return {
        path: relativePath,
        sizeBytes: stat.size,
        sha256: null,
        skippedReason: `exceeds ${UNTRACKED_CONTENT_MAX_FILE_BYTES}-byte cheap-hash cap`,
      };
    }
    return {
      path: relativePath,
      sizeBytes: stat.size,
      sha256: sha256(fs.readFileSync(absolutePath)),
      skippedReason: null,
    };
  });
  return {
    enabled: true,
    files,
    truncated,
    unavailableReason: null,
    includePrefixes: UNTRACKED_CONTENT_INCLUDE_PREFIXES,
    excludedPrefixes: EXCLUDED_UNTRACKED_PREFIXES,
  };
}

function commandVersion(command, args) {
  // Some backends (llama-server) print --version to stderr and exit 0, not
  // stdout; execFileSync's return value alone would miss that. spawnSync
  // exposes both streams regardless of exit code.
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output || null;
}

function runtime() {
  return {
    node: process.version,
    npm: commandVersion("npm", ["--version"]),
    python:
      commandVersion("python3", ["--version"]) ??
      commandVersion("python", ["--version"]),
    platform: {
      name: process.platform,
      arch: process.arch,
      release: os.release() || null,
      version: typeof os.version === "function" ? os.version() || null : null,
    },
  };
}

function normalizeIdentifiers(options) {
  const identifiers = {};
  if (options.model !== undefined) identifiers.model = options.model;
  if (options.prompt !== undefined) identifiers.prompt = options.prompt;
  if (options.taskSuite !== undefined)
    identifiers.taskSuite = options.taskSuite;
  return identifiers;
}

export function captureBaseline({
  root = REPO_ROOT,
  model,
  prompt,
  taskSuite,
  // Both default OFF: see untrackedSourceContent()/modelIdentity() above for
  // why reading untracked file bytes and hashing multi-GB weights are each
  // opt-in rather than part of the default, always-safe capture.
  includeUntrackedContent = false,
  hashModelArtifact = false,
} = {}) {
  const head = gitHead(root);
  const diff = trackedDiff(root);
  const inventory = untrackedPaths(root);
  const trackedDiffSha256 = sha256(diff.bytes);
  const untrackedPathInventorySha256 = sha256(
    Buffer.concat(
      inventory.paths.flatMap((entry) => [entry, Buffer.from([0])]),
    ),
  );
  const gitAvailable = head !== null || diff.available || inventory.available;

  return {
    schema: SCHEMA,
    version: VERSION,
    git: {
      head,
      trackedDiffSha256: gitAvailable ? trackedDiffSha256 : null,
      trackedChanges: gitAvailable ? diff.bytes.length > 0 : null,
      // The hash alone proved only that a diff didn't change; it never let
      // anyone replay it. `main()` sets these two fields to the actual
      // sidecar patch path when it writes a capture to --output (a hash is
      // not a backup -- ACCEPTANCE.md Gate 1). Calling captureBaseline()
      // directly (as the unit tests do) leaves them at these safe defaults:
      // no side effect happens unless a real capture output path exists.
      trackedDiffRetained: false,
      trackedDiffPatchPath: null,
      untrackedPathInventorySha256: gitAvailable
        ? untrackedPathInventorySha256
        : null,
      untrackedPathCount: gitAvailable ? inventory.paths.length : null,
      clean: gitAvailable
        ? diff.bytes.length === 0 && inventory.paths.length === 0
        : null,
    },
    files: fileHashes(root),
    runtime: runtime(),
    // --- Gate-1 identity fields added in schema v2 (read-only, cheap by
    // default; see each helper's docstring for exactly what is/isn't
    // gathered and why) ---
    cli: cliIdentity(root),
    // Named "modelProfile" (not "model") to avoid ambiguity with the
    // pre-existing `identifiers.model` freeform experiment-id field below.
    modelProfile: modelIdentity(root, { hashModelArtifact }),
    backend: backendVersions(root),
    hardware: hardwareIdentity(),
    workspace: workspaceIdentity(),
    untrackedSource: untrackedSourceContent(root, inventory.paths, {
      enabled: includeUntrackedContent,
    }),
    identifiers: normalizeIdentifiers({ model, prompt, taskSuite }),
  };
}

function isSha256(value) {
  return (
    value === null ||
    (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  );
}

function isNullOr(value, predicate) {
  return value === null || predicate(value);
}

function validateBaselineGitAndFiles(baseline) {
  const git = baseline.git;
  if (
    !git ||
    !isSha256(git.trackedDiffSha256) ||
    !isSha256(git.untrackedPathInventorySha256)
  )
    return false;
  if (
    !(
      Number.isInteger(git.untrackedPathCount) ||
      git.untrackedPathCount === null
    )
  )
    return false;
  if (!(typeof git.clean === "boolean" || git.clean === null)) return false;
  if (
    !baseline.files ||
    typeof baseline.files !== "object" ||
    Array.isArray(baseline.files)
  )
    return false;
  return KEY_FILES.every(
    (relativePath) =>
      Object.hasOwn(baseline.files, relativePath) &&
      isSha256(baseline.files[relativePath]),
  );
}

// Validates the original, frozen shape (e.g. the Sep-18 artifact). Kept
// exactly as it always behaved so historical baselines remain readable/valid
// under the same rule they were captured against -- this file does not
// silently reinterpret them as satisfying the richer v2 requirements below.
function validateBaselineV1(baseline) {
  return validateBaselineGitAndFiles(baseline);
}

// Validates a v2 capture: every v1 check, plus presence and correct
// null-or-populated shape for the Gate-1 identity fields added above. A
// field being `null` is valid (it must carry an accompanying *UnavailableReason
// string saying why); a field being absent entirely is not.
function validateBaselineV2(baseline) {
  if (!validateBaselineGitAndFiles(baseline)) return false;
  const git = baseline.git;
  if (typeof git.trackedDiffRetained !== "boolean") return false;
  if (!isNullOr(git.trackedDiffPatchPath, (value) => typeof value === "string"))
    return false;

  const cli = baseline.cli;
  if (!cli || typeof cli !== "object") return false;
  if (!isNullOr(cli.bundleSha256, isSha256)) return false;
  if (!("bundleUnavailableReason" in cli)) return false;

  const modelProfile = baseline.modelProfile;
  if (!modelProfile || typeof modelProfile !== "object") return false;
  if (!Array.isArray(modelProfile.artifacts)) return false;
  if (!("profileUnavailableReason" in modelProfile)) return false;

  const backend = baseline.backend;
  if (!backend || !Array.isArray(backend.llama)) return false;

  const hardware = baseline.hardware;
  if (
    !hardware ||
    !(Number.isInteger(hardware.cpuCount) || hardware.cpuCount === null) ||
    typeof hardware.ramTotalBytes !== "number" ||
    !Array.isArray(hardware.gpu)
  )
    return false;

  const workspace = baseline.workspace;
  if (!workspace || typeof workspace !== "object") return false;

  const untrackedSource = baseline.untrackedSource;
  if (
    !untrackedSource ||
    typeof untrackedSource.enabled !== "boolean" ||
    !Array.isArray(untrackedSource.files)
  )
    return false;

  return true;
}

export function validateBaseline(baseline) {
  if (!baseline || baseline.schema !== SCHEMA) return false;
  if (baseline.version === LEGACY_VERSION) return validateBaselineV1(baseline);
  if (baseline.version === VERSION) return validateBaselineV2(baseline);
  return false;
}

function atomicWrite(filename, contents) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.tmp-${process.pid}`,
  );
  const assertExistingMatches = () => {
    let stat;
    try {
      stat = fs.lstatSync(filename);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `refusing to replace non-regular baseline artifact: ${filename}`,
      );
    }
    if (fs.readFileSync(filename, "utf8") === contents) return true;
    throw new Error(
      `refusing to overwrite different immutable baseline artifact: ${filename}`,
    );
  };

  if (assertExistingMatches()) return;
  try {
    fs.writeFileSync(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    // link(2) creates the destination name atomically and, unlike rename,
    // refuses to replace a baseline that another process created after the
    // preflight check. The temporary file lives in the same directory/filesystem.
    try {
      fs.linkSync(temporary, filename);
    } catch (error) {
      if (error?.code === "EEXIST" && assertExistingMatches()) return;
      throw error;
    }
  } catch (error) {
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* preserve the original error */
    }
  }
}

export function parseArgs(argv) {
  const options = { output: null, validateOnly: false };
  const aliases = {
    "--task-suite-id": "taskSuite",
    "--task-suite": "taskSuite",
    "--model-id": "model",
    "--prompt-id": "prompt",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--validate-only" || arg === "--no-mutation") {
      options.validateOnly = true;
      continue;
    }
    // Deliberately only ever assigned when passed -- never pre-populated in
    // the base `options` literal above -- so a caller that never mentions
    // these flags gets back the exact same shape parseArgs has always
    // returned (existing tests assert an exact options object for one such
    // call). captureBaseline()'s own defaults (both false) apply identically
    // whether the key is `undefined` or simply absent.
    if (arg === "--with-untracked-content") {
      options.includeUntrackedContent = true;
      continue;
    }
    if (arg === "--hash-model-artifact") {
      options.hashModelArtifact = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const key =
      aliases[name] ??
      { "--output": "output", "--model": "model", "--prompt": "prompt" }[name];
    if (!key) throw new Error(`unknown argument: ${arg}`);
    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
    if (!value) throw new Error(`${name} requires a value`);
    options[key] = value;
  }
  return options;
}

export const HELP = `Usage: node scripts/capture-plan-baseline.mjs [options]

Capture a deterministic experiment baseline: git/file/runtime metadata plus
(schema v2) CLI bundle, model-profile, backend, hardware, and workspace
identity. Fields that cannot be gathered read-only/cheaply are recorded as
explicit null with a reason, never fabricated or silently omitted.

Options:
  --output PATH             Atomically write JSON to PATH instead of stdout.
                            Also retains the tracked-diff blob (not just its
                            hash) as PATH.tracked-diff.patch.
  --model ID                Optional model identifier
  --prompt ID                Optional prompt identifier
  --task-suite ID           Optional task-suite identifier
  --validate-only           Capture and validate, but never write a file
  --no-mutation              Alias for --validate-only
  --with-untracked-content  Also content-hash untracked files under the
                            explicit include-list (scripts/, docs/,
                            benchmarks/, data/, apps/cli/{packages,scripts}/,
                            web/{src,public}/), excluding secret-like names.
                            Off by default: no untracked file content is read
                            unless this is passed.
  --hash-model-artifact     Also sha256 the configured model's .gguf file(s).
                            Off by default: multi-GB weights are identified
                            by path/size/mtime only, for cost.
  --help                     Show this help
`;

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const baseline = captureBaseline(options);
  const willWriteOutput = Boolean(options.output && !options.validateOnly);
  let diffPatchPath = null;
  if (willWriteOutput) {
    // Retain the actual diff bytes next to the capture, not only their hash
    // (ACCEPTANCE.md Gate 1: "a hash is not a backup"). This reuses the same
    // diff already computed inside captureBaseline() conceptually, but must
    // be recomputed here since captureBaseline() itself stays a pure,
    // side-effect-free function for the unit tests that call it directly.
    diffPatchPath = `${path.resolve(options.output)}.tracked-diff.patch`;
    baseline.git.trackedDiffRetained = true;
    baseline.git.trackedDiffPatchPath = diffPatchPath;
  }
  if (!validateBaseline(baseline))
    throw new Error("internal baseline validation failed");
  const serialized = `${JSON.stringify(baseline, null, 2)}\n`;
  if (willWriteOutput) {
    atomicWrite(path.resolve(options.output), serialized);
    const diff = trackedDiff(REPO_ROOT);
    atomicWrite(diffPatchPath, diff.bytes.toString("utf8"));
  } else {
    process.stdout.write(serialized);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`capture-plan-baseline: ${error.message}\n`);
    process.exitCode = 1;
  }
}
