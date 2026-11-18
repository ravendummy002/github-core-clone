// The small HTTP plumbing the surfaces share: the request context, JSON responses,
// the bearer-token check, and the request-id header every REST reply carries.

export interface RequestContext {
  method: string;
  pathname: string;
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** The request's Host header, used to build absolute pagination links. */
  host: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

let requestCounter = 0;

/** The next deterministic request id: `req-<n>`, never a random value. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function jsonResponse(status: number, value: unknown, extra: Record<string, string> = {}): HttpResponse {
  // JSON.stringify(undefined) is undefined, not a string; guard the one value that would break Buffer.from.
  const text = value === undefined ? 'null' : JSON.stringify(value);
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': nextRequestId(),
      ...extra,
    },
    body: Buffer.from(text, 'utf8'),
  };
}

/** A JSON response from an already-serialized body (the read workload's fast path). */
export function jsonResponseRaw(status: number, body: string, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': nextRequestId(),
      ...extra,
    },
    body: Buffer.from(body, 'utf8'),
  };
}

export function jsonError(status: number, message: string): HttpResponse {
  return jsonResponse(status, { message });
}

export function emptyResponse(status: number): HttpResponse {
  return {
    status,
    headers: { 'x-github-request-id': nextRequestId() },
    body: Buffer.alloc(0),
  };
}

/** Parse the request body as JSON, or return null when it is not valid JSON. */
export function parseJsonBody(ctx: RequestContext): unknown | null {
  if (ctx.body.length === 0) return null;
  try {
    return JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

export function bearerToken(ctx: RequestContext): string | null {
  const header = ctx.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(value.trim());
  return match === null ? null : (match[1] as string);
}

/**
 * The bearer token this forge expects: MAKEFUN_SHOP_TOKEN. When the variable is
 * unset (local development), any bearer token is accepted, but a missing one is
 * still refused — the 401 behaviour stays intact either way.
 */
export function isAuthorized(ctx: RequestContext): boolean {
  const presented = bearerToken(ctx);
  if (presented === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}

/** Read a positive-integer query parameter, clamped, with a default. */
export function queryInt(ctx: RequestContext, name: string, fallback: number, min: number, max: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * A GitHub-style Link header for a paginated collection. The URLs are absolute —
 * the suite's client only follows same-origin links — and keep the caller's other
 * query parameters.
 */
export function paginationLink(ctx: RequestContext, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const build = (targetPage: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return `http://${ctx.host}${ctx.pathname}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`);
  parts.push(`<${build(totalPages)}>; rel="last"`);
  if (page > 1) parts.push(`<${build(1)}>; rel="first"`);
  if (page > 1) parts.push(`<${build(page - 1)}>; rel="prev"`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** Slice a page out of a list, applying the caller's per_page and page. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}
