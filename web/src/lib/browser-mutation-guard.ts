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

  let targetOrigin: string;
  try {
    targetOrigin = new URL(request.url).origin;
  } catch {
    // A Route Handler always has an absolute URL, but retain a fail-closed
    // result for direct/unit callers as well.
    return { ok: false, status: 403, code: "origin_invalid" };
  }

  if (suppliedOrigin.origin !== targetOrigin && !sameLoopbackOrigin(suppliedOrigin.origin, targetOrigin)) {
    return { ok: false, status: 403, code: "origin_mismatch" };
  }

  return { ok: true };
}

// The launcher opens the browser at http://127.0.0.1:8771 while the Next dev
// server reports its own origin as http://localhost:8771, so a strict string
// compare rejected every save with origin_mismatch (observed live: all model
// settings writes 403'd, settings.json never gained a modelSettings block).
// 127.0.0.1, localhost, and ::1 are the same machine's loopback; treat them as
// one origin when scheme and port match. CSRF protection is unaffected — a real
// cross-site page's Origin is its own public host, never a loopback name.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function sameLoopbackOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.protocol === ub.protocol
      && ua.port === ub.port
      && LOOPBACK_HOSTS.has(ua.hostname)
      && LOOPBACK_HOSTS.has(ub.hostname)
    );
  } catch {
    return false;
  }
}
