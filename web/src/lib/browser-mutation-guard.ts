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

  if (suppliedOrigin.origin !== targetOrigin) {
    return { ok: false, status: 403, code: "origin_mismatch" };
  }

  return { ok: true };
}
