import fs from "node:fs";
import path from "node:path";

/**
 * The persisted authority boundary for browser-accessible workspaces.  A
 * project picker entry is not authority by itself: a path must be present in
 * this repository before any filesystem route can use it.
 */
export const WORKSPACE_GRANTS_SCHEMA_VERSION = 1 as const;

export type WorkspaceGrant = Readonly<{ path: string; grantedAt: string }>;
type StoredWorkspaceGrants = { schemaVersion: typeof WORKSPACE_GRANTS_SCHEMA_VERSION; grants: WorkspaceGrant[] };

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function canonicalDirectory(raw: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(raw));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * A deliberately small JSON repository, with atomic replacement so a stopped
 * dev server never leaves a partially-written authority list.  Invalid or old
 * files fail closed rather than silently restoring broad filesystem access.
 */
export class WorkspaceGrantRepository {
  private readonly file: string;
  private readonly defaultWorkspace: string;

  constructor(file: string, defaultWorkspace: string) {
    this.file = file;
    this.defaultWorkspace = defaultWorkspace;
  }

  private read(): StoredWorkspaceGrants {
    try {
      const stored: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { schemaVersion: WORKSPACE_GRANTS_SCHEMA_VERSION, grants: [] };
      const record = stored as Record<string, unknown>;
      if (record.schemaVersion !== WORKSPACE_GRANTS_SCHEMA_VERSION || !Array.isArray(record.grants)) return { schemaVersion: WORKSPACE_GRANTS_SCHEMA_VERSION, grants: [] };
      const grants = record.grants.flatMap((grant): WorkspaceGrant[] => {
        if (!grant || typeof grant !== "object" || Array.isArray(grant)) return [];
        const entry = grant as Record<string, unknown>;
        return typeof entry.path === "string" && path.isAbsolute(entry.path) && typeof entry.grantedAt === "string"
          ? [{ path: entry.path, grantedAt: entry.grantedAt }]
          : [];
      });
      return { schemaVersion: WORKSPACE_GRANTS_SCHEMA_VERSION, grants };
    } catch {
      return { schemaVersion: WORKSPACE_GRANTS_SCHEMA_VERSION, grants: [] };
    }
  }

  private write(grants: WorkspaceGrant[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: WORKSPACE_GRANTS_SCHEMA_VERSION, grants }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
      if (process.platform !== "win32") fs.chmodSync(this.file, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* rename already consumed it */ }
    }
  }

  /** The default workspace is the one safe compatibility exception. */
  private defaultRoot(): string | null { return canonicalDirectory(this.defaultWorkspace); }

  list(): WorkspaceGrant[] {
    return this.read().grants.filter((grant) => canonicalDirectory(grant.path) === grant.path);
  }

  grant(raw: string, now = new Date()): WorkspaceGrant | null {
    const root = canonicalDirectory(raw);
    if (!root) return null;
    const grants = this.read().grants.filter((grant) => grant.path !== root);
    const grant = Object.freeze({ path: root, grantedAt: now.toISOString() });
    grants.unshift(grant);
    this.write(grants);
    return grant;
  }

  revoke(raw: string): boolean {
    const requested = canonicalDirectory(raw) ?? path.resolve(raw);
    const grants = this.read().grants;
    const remaining = grants.filter((grant) => grant.path !== requested);
    if (remaining.length === grants.length) return false;
    this.write(remaining);
    return true;
  }

  /** Returns a canonical root only while the current grant still authorizes it. */
  resolveGrantedDirectory(raw: string): string | null {
    const candidate = canonicalDirectory(raw);
    if (!candidate) return null;
    const defaultRoot = this.defaultRoot();
    if (defaultRoot && isWithin(defaultRoot, candidate)) return candidate;
    return this.read().grants.some((grant) => isWithin(grant.path, candidate)) ? candidate : null;
  }
}

const DATA = path.join(process.cwd(), ".data");
export const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");
export const workspaceGrantRepository = new WorkspaceGrantRepository(path.join(DATA, "workspace-grants.json"), DEFAULT_WORKSPACE);
