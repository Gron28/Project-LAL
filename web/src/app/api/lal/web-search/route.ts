import { webSearch } from '@/lib/lab';
import {
  cliAuthorized,
  recordCliAccess,
  unauthorizedResponse,
} from '@/lib/lal-cli';

export const dynamic = 'force-dynamic';

const MAX_QUERY_CHARS = 500;

export async function POST(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, 'web search', authorized);
  if (!authorized) return unauthorizedResponse();

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
  const results = await webSearch(normalized);
  if (/^\(web search (?:failed|appears blocked\/rate-limited)/i.test(results)) {
    return Response.json({ error: results }, { status: 502 });
  }
  return Response.json({ query: normalized, results });
}
