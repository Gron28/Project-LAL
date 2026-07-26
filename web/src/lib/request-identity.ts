/**
 * Request identity is deliberately separate from authorization.  In particular,
 * forwarding headers such as X-Forwarded-For do not prove who connected to this
 * process and are never used here.  A caller that has access to the Node socket
 * must pass its observed peer address; Next.js Route Handlers do not expose it.
 *
 * Tailscale Serve removes client-supplied Tailscale identity headers before
 * adding its own.  They are still safe to trust only when this app listens on
 * loopback and the accepted socket peer is loopback.
 */

export const TAILSCALE_IDENTITY_HEADERS = [
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic",
] as const;

export type RequestConnection = {
  /** The remote address observed from the accepted server socket, never a request header. */
  peerAddress?: string | null;
};

export type RequestIdentity =
  | {
    state: "authenticated";
    source: "tailscale-serve";
    subject: string;
    displayName?: string;
    profilePictureUrl?: string;
  }
  | {
    state: "anonymous";
    connection: "loopback" | "remote" | "unknown";
  }
  | {
    state: "rejected";
    reason: "untrusted_tailscale_headers" | "invalid_tailscale_identity";
  };

function normaliseAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1];
  return bracketed ?? trimmed;
}

/** True for the address forms Node may report for a loopback TCP peer. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalised = normaliseAddress(address);
  if (normalised === "::1" || normalised === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = normalised.startsWith("::ffff:") ? normalised.slice("::ffff:".length) : normalised;
  const octets = ipv4.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function cleanHeader(value: string | null, maximumLength: number): string | undefined {
  if (value === null) return undefined;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximumLength || /[\u0000-\u001f\u007f]/.test(cleaned)) return undefined;
  return cleaned;
}

function suppliedTailscaleHeaders(headers: Headers): boolean {
  return TAILSCALE_IDENTITY_HEADERS.some((header) => headers.has(header));
}

function connectionKind(peerAddress: string | null | undefined): "loopback" | "remote" | "unknown" {
  if (!peerAddress) return "unknown";
  return isLoopbackAddress(peerAddress) ? "loopback" : "remote";
}

/**
 * Extract an authenticated Tailscale Serve principal only from a verified
 * loopback connection.  Requests with any Tailscale header on a direct/LAN or
 * peer-unknown connection are rejected rather than silently downgraded, so a
 * later mutation guard cannot accidentally treat a spoof attempt as anonymous.
 */
export function extractRequestIdentity(request: Request, connection: RequestConnection): RequestIdentity {
  const { headers } = request;
  const hasTailscaleHeaders = suppliedTailscaleHeaders(headers);
  const connectionState = connectionKind(connection.peerAddress);

  if (hasTailscaleHeaders && connectionState !== "loopback") {
    return { state: "rejected", reason: "untrusted_tailscale_headers" };
  }

  if (!hasTailscaleHeaders) return { state: "anonymous", connection: connectionState };

  const subject = cleanHeader(headers.get("tailscale-user-login"), 512);
  const displayName = cleanHeader(headers.get("tailscale-user-name"), 512);
  const profilePictureUrl = cleanHeader(headers.get("tailscale-user-profile-pic"), 2_048);
  if (!subject) return { state: "rejected", reason: "invalid_tailscale_identity" };

  return {
    state: "authenticated",
    source: "tailscale-serve",
    subject,
    ...(displayName ? { displayName } : {}),
    ...(profilePictureUrl ? { profilePictureUrl } : {}),
  };
}
