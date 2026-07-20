/**
 * Slice 8's local media boundary. It accepts already-owned bytes only: an
 * explicitly-authorized local file or a base64 data URL. It never dereferences
 * a remote URL, sniffs/executes media, invokes a decoder, or emits a preview.
 *
 * Bytes are content-addressed before becoming visible. Callers must supply an
 * independently authenticated MediaArtifactAccess to read them back; this
 * module intentionally does not treat a browser header as authentication.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MEDIA_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const MAX_MEDIA_ARTIFACT_BYTES = 64 * 1024 * 1024;
export type MediaArtifactId = `media:sha256:${string}`;
export type MediaSource = { kind: "data-url"; value: string } | { kind: "local-file"; path: string };
export type MediaKind = "image" | "audio" | "video" | "document" | "other";
export type MediaArtifactAccess = { subject: string; capabilities: readonly string[] };
export type MediaArtifactMetadata = {
  schemaVersion: typeof MEDIA_ARTIFACT_SCHEMA_VERSION;
  id: MediaArtifactId;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  kind: MediaKind;
  createdAt: string;
  ownerSubject: string;
  /** A subject:<id> or capability:<scope> selector; authorization is external. */
  readGrants: string[];
  sourceKind: MediaSource["kind"];
  fileName?: string;
};
export type IngestMediaArtifact = {
  source: MediaSource;
  ownerSubject: string;
  readGrants: readonly string[];
  fileName?: string;
  mimeType?: string;
  /** Required for local-file sources. It receives a canonical existing path. */
  authorizeLocalPath?: (realPath: string) => boolean;
  now?: () => Date;
};

/** Explicit job payloads only; a worker may observe/transcribe bytes but never execute them. */
export type MediaObservationJobInput = {
  kind: "media.observe";
  artifactId: MediaArtifactId;
  requestedBy: string;
  capabilities: ["media.observe"];
  observation: "describe" | "classify" | "extract-metadata";
};
export type MediaTranscriptJobInput = {
  kind: "media.transcribe";
  artifactId: MediaArtifactId;
  requestedBy: string;
  capabilities: ["media.transcribe"];
  language?: string;
  diarization?: false;
};
export type MediaAnalysisJobInput = MediaObservationJobInput | MediaTranscriptJobInput;

function validDigest(value: string): boolean { return /^[a-f0-9]{64}$/i.test(value); }
function artifactId(digest: string): MediaArtifactId { return `media:sha256:${digest}`; }
function hash(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function asMime(value: string | undefined): string {
  const mime = (value ?? "application/octet-stream").trim().toLowerCase();
  if (!/^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+$/.test(mime)) throw new Error("invalid media MIME type");
  return mime;
}
function kindForMime(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "document";
  return "other";
}
function cleanSubject(value: string): string {
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("ownerSubject is required");
  return result;
}
function cleanGrants(grants: readonly string[]): string[] {
  const cleaned = [...new Set(grants.map((grant) => grant.trim()))].sort();
  if (!cleaned.length || cleaned.some((grant) => !/^(subject|capability):[^\u0000-\u001f\u007f]{1,512}$/.test(grant))) throw new Error("readGrants must contain subject: or capability: selectors");
  return cleaned;
}
function cleanFileName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim();
  if (!result || result.length > 255 || result.includes("/") || result.includes("\\") || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("invalid media fileName");
  return result;
}
function dataUrlBytes(value: string): { bytes: Buffer; mimeType: string } {
  // Deliberately only base64 data URLs. Percent-encoded URL data is not a
  // transport we need to support and makes byte limits less obvious.
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) throw new Error("media source must be a base64 data: URL, never a remote URL");
  const encoded = match[2] ?? "";
  if (!encoded || encoded.length % 4 !== 0) throw new Error("invalid base64 media data");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) throw new Error("invalid base64 media data");
  return { bytes, mimeType: asMime(match[1]) };
}
function ensureSize(bytes: Buffer): void { if (!bytes.length || bytes.length > MAX_MEDIA_ARTIFACT_BYTES) throw new Error(`media artifact must be between 1 and ${MAX_MEDIA_ARTIFACT_BYTES} bytes`); }
function metadataPath(root: string, digest: string): string { return path.join(root, "sha256", digest, "metadata.json"); }
function bytesPath(root: string, digest: string): string { return path.join(root, "sha256", digest, "bytes"); }

export function canReadMediaArtifact(metadata: MediaArtifactMetadata, access: MediaArtifactAccess): boolean {
  const subject = access.subject.trim();
  if (!subject || !access.capabilities.includes("media.artifact.read")) return false;
  return metadata.readGrants.includes(`subject:${subject}`)
    || access.capabilities.some((capability) => metadata.readGrants.includes(`capability:${capability}`));
}

/** A content-addressed local repository; `root` must be an explicit absolute owner-state directory. */
export class MediaArtifactRepository {
  private readonly root: string;
  constructor(root: string) { if (!path.isAbsolute(root)) throw new Error("media artifact root must be absolute"); this.root = root; }

  ingest(input: IngestMediaArtifact): MediaArtifactMetadata {
    const ownerSubject = cleanSubject(input.ownerSubject), readGrants = cleanGrants(input.readGrants), fileName = cleanFileName(input.fileName);
    let bytes: Buffer, sourceMime: string | undefined;
    if (input.source.kind === "data-url") {
      const parsed = dataUrlBytes(input.source.value); bytes = parsed.bytes; sourceMime = parsed.mimeType;
    } else {
      if (!path.isAbsolute(input.source.path)) throw new Error("local media source path must be absolute");
      const realPath = fs.realpathSync(input.source.path);
      if (!input.authorizeLocalPath?.(realPath)) throw new Error("local media source is not authorized");
      const stat = fs.statSync(realPath);
      if (!stat.isFile()) throw new Error("local media source must be a regular file");
      if (stat.size < 1 || stat.size > MAX_MEDIA_ARTIFACT_BYTES) throw new Error(`media artifact must be between 1 and ${MAX_MEDIA_ARTIFACT_BYTES} bytes`);
      bytes = fs.readFileSync(realPath);
    }
    ensureSize(bytes);
    const digest = hash(bytes), dir = path.dirname(bytesPath(this.root, digest));
    const metadata: MediaArtifactMetadata = {
      schemaVersion: MEDIA_ARTIFACT_SCHEMA_VERSION, id: artifactId(digest), sha256: digest, sizeBytes: bytes.length,
      mimeType: asMime(input.mimeType ?? sourceMime), kind: kindForMime(asMime(input.mimeType ?? sourceMime)),
      createdAt: (input.now ?? (() => new Date()))().toISOString(), ownerSubject, readGrants, sourceKind: input.source.kind,
      ...(fileName ? { fileName } : {}),
    };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const destination = bytesPath(this.root, digest);
    if (fs.existsSync(destination)) {
      // Never overwrite an existing digest path: verify the existing bytes
      // before returning metadata so filesystem tampering cannot be hidden.
      if (hash(fs.readFileSync(destination)) !== digest) throw new Error("existing media artifact failed content verification");
      const existing = this.get(metadata.id);
      if (!existing) throw new Error("existing media artifact metadata is missing or invalid");
      return existing;
    }
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    const metadataTemporary = `${metadataPath(this.root, digest)}.${process.pid}.tmp`;
    fs.writeFileSync(metadataTemporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(metadataTemporary, metadataPath(this.root, digest));
    return metadata;
  }

  get(id: string): MediaArtifactMetadata | null {
    const digest = this.digestFromId(id); if (!digest) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(metadataPath(this.root, digest), "utf8")) as MediaArtifactMetadata;
      if (raw.schemaVersion !== MEDIA_ARTIFACT_SCHEMA_VERSION || raw.id !== artifactId(digest) || raw.sha256 !== digest || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 1 || !asMime(raw.mimeType) || !Array.isArray(raw.readGrants)) return null;
      return raw;
    } catch { return null; }
  }

  /** Returns bytes only after access and full SHA-256/size verification. */
  readAuthorized(id: string, access: MediaArtifactAccess): { metadata: MediaArtifactMetadata; bytes: Buffer; headers: Readonly<Record<string, string>> } | null {
    const metadata = this.get(id); if (!metadata || !canReadMediaArtifact(metadata, access)) return null;
    try {
      const bytes = fs.readFileSync(bytesPath(this.root, metadata.sha256));
      if (bytes.length !== metadata.sizeBytes || hash(bytes) !== metadata.sha256) return null;
      // No inline rendering contract: a later HTTP adapter must forward these
      // exact headers rather than deciding media behavior from a filename.
      return { metadata, bytes, headers: Object.freeze({
        "content-type": metadata.mimeType,
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "content-security-policy": "sandbox",
      }) };
    } catch { return null; }
  }

  private digestFromId(id: string): string | null { const match = /^media:sha256:([a-f0-9]{64})$/i.exec(id); return match && validDigest(match[1]!) ? match[1]!.toLowerCase() : null; }
}
