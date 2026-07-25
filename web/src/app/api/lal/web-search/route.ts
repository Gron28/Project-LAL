import { webSearch } from '@/lib/lab';
import {
  cliAuthorized,
  recordCliAccess,
  unauthorizedResponse,
} from '@/lib/lal-cli';

export const dynamic = 'force-dynamic';

const MAX_QUERY_CHARS = 500;

// Every outcome of this route is logged to the service journal.
//
// The operator reported on 2026-07-24 that web_search did not work from Windows.
// The backend was verified healthy by direct call, but there was no way to tell
// whether the client's search ever ARRIVED — Next.js logs no requests in
// production, and project-lal.service's journal held only startup lines. Two
// separate diagnoses were attempted from that absence and both were guesses.
// One line per call ends that: `journalctl --user -u project-lal.service | grep
// web-search` now answers "did it reach the host, and what happened".
function logSearch(outcome: string, detail: Record<string, unknown>): void {
  const fields = Object.entries(detail)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  console.log(`[lal-web-search] ${outcome} ${fields}`);
}

function callerId(request: Request): string {
  return (
    request.headers.get('x-lal-device-name') ??
    request.headers.get('x-lal-device-id') ??
    'unknown'
  );
}

export async function POST(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, 'web search', authorized);
  const caller = callerId(request);
  const clientVersion = request.headers.get('x-lal-client-version') ?? 'unknown';
  if (!authorized) {
    // A silent 401 here looks exactly like "web search is broken" to the model,
    // and is the single most likely client-side cause.
    logSearch('unauthorized', { caller, clientVersion });
    return unauthorizedResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const query =
    typeof body === 'object' && body !== null && 'query' in body
      ? (body as { query?: unknown }).query
      : undefined;
  if (typeof query !== 'string' || !query.trim()) {
    return Response.json(
      { error: 'query must be a non-empty string' },
      { status: 400 },
    );
  }
  if (query.trim().length > MAX_QUERY_CHARS) {
    return Response.json(
      { error: `query cannot exceed ${MAX_QUERY_CHARS} characters` },
      { status: 400 },
    );
  }

  const normalized = query.trim();
  const startedAt = Date.now();
  let results: string;
  try {
    results = await webSearch(normalized);
  } catch (error) {
    logSearch('threw', {
      caller,
      clientVersion,
      chars: normalized.length,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: 'web search failed on the host' },
      { status: 502 },
    );
  }
  const ms = Date.now() - startedAt;
  if (/^\(web search (?:failed|appears blocked\/rate-limited)/i.test(results)) {
    logSearch('provider-refused', {
      caller,
      clientVersion,
      chars: normalized.length,
      ms,
      detail: results.slice(0, 200),
    });
    return Response.json({ error: results }, { status: 502 });
  }
  logSearch('ok', {
    caller,
    clientVersion,
    chars: normalized.length,
    ms,
    resultChars: results.length,
  });
  return Response.json({ query: normalized, results });
}
