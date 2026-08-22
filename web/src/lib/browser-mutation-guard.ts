/**
 * Same-origin boundary for state-changing endpoints used by the browser UI.
 *
 * This guard deliberately fails closed: an absent, malformed, or mismatched
 * Origin header is not a browser request we can authorize.  It is a CSRF
 * boundary, not a substitute for authenticating a user or a service.
 *
 * Do not apply this guard to machine-to-machine endpoints merely by allowing a
 * missing Origin.  CLI/LAL endpoints must use their own explicit capability or
 * authenticated transport policy.  Keep those routes separate from browser
 * routes so an unauthenticated non-browser request cannot inherit browser
 * privileges.
 */

export type BrowserMutationAuthorization =
  | { ok: true }
  | {
    ok: false;
    status: 403;
    code: "origin_required" | "origin_invalid" | "origin_mismatch";
  };

type TargetOriginResult =
  | { ok: true; origin: string }
  | { ok: false };

function singletonHeader(request: Request, name: string): string | undefined | null {
  const raw = request.headers.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  // Forwarding headers can legally be lists, but selecting the wrong hop would
  // weaken this boundary. LAL's supported proxy (Tailscale Serve) supplies one
  // value, so ambiguous or empty values fail closed.
  if (!value || value.includes(",")) return null;
  return value;
}

/**
 * Resolve the origin the browser actually addressed.
 *
 * Next.js constructs `request.url` from the server's bind hostname. Behind
 * Tailscale Serve that produces (for example) `https://localhost:8770` even
 * though the browser addressed `https://machine.example.ts.net:8443`. HTTP's
 * Host authority, plus the proxy's forwarded scheme/host when present, is the
 * correct comparison target for same-origin protection.
 */
function browserFacingTargetOrigin(request: Request): TargetOriginResult {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return { ok: false };
  }

  const forwardedProtocol = singletonHeader(request, "x-forwarded-proto");
  const forwardedHost = singletonHeader(request, "x-forwarded-host");
  const host = singletonHeader(request, "host");
  if (forwardedProtocol === null || forwardedHost === null || host === null) return { ok: false };

  const protocol = forwardedProtocol ?? requestUrl.protocol.slice(0, -1);
  const authority = forwardedHost ?? host ?? requestUrl.host;
  if (protocol !== "http" && protocol !== "https") return { ok: false };

  try {
    const target = new URL(`${protocol}://${authority}`);
    if (
      target.username
      || target.password
      || target.pathname !== "/"
      || target.search
      || target.hash
    ) {
      return { ok: false };
    }
    return { ok: true, origin: target.origin };
  } catch {
    return { ok: false };
  }
}

/**
 * Authorize an unsafe request made by the browser UI only when its Origin is
 * exactly the route's own origin.  `Origin: null` and a missing Origin are
 * rejected deliberately.
 */
export function authorizeBrowserMutation(request: Request): BrowserMutationAuthorization {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return { ok: false, status: 403, code: "origin_required" };

  let suppliedOrigin: URL;
  try {
    suppliedOrigin = new URL(originHeader);
  } catch {
    return { ok: false, status: 403, code: "origin_invalid" };
  }

  // Origin is serialized as scheme + host + port. Reject arbitrary URLs that
  // merely share an origin after URL parsing (for example a path or credentials).
  if (
    originHeader !== suppliedOrigin.origin
    || suppliedOrigin.username
    || suppliedOrigin.password
    || suppliedOrigin.pathname !== "/"
    || suppliedOrigin.search
    || suppliedOrigin.hash
  ) {
    return { ok: false, status: 403, code: "origin_invalid" };
  }

  const targetOrigin = browserFacingTargetOrigin(request);
  if (!targetOrigin.ok) return { ok: false, status: 403, code: "origin_invalid" };

  if (suppliedOrigin.origin !== targetOrigin.origin) {
    return { ok: false, status: 403, code: "origin_mismatch" };
  }

  return { ok: true };
}
