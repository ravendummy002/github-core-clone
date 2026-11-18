// makefun-forge: a standalone GitHub-compatible git forge in one Node process.
//
// Lifecycle, as the wire contract requires:
//   1. Bind an ephemeral port of the kernel's choosing (port 0 — never 8080,
//      which the suite listens on).
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register within 20 seconds of boot.
//   3. Answer GET /healthz with 200 {"ok": true}.
//   4. Long-poll GET $MAKEFUN_ENV_URL/done; when it answers {"done": true}, exit 0.
//
// The forge itself is src/server.ts (git smart HTTP, REST v3, GraphQL, MCP),
// all served from one in-memory store. Without MAKEFUN_ENV_URL the forge simply
// runs until it is stopped, which is how local development drives it.

import { createForgeServer } from './src/server.ts';

const REGISTER_BUDGET_MS = 15_000;
const REGISTER_RETRY_MS = 500;
const DONE_POLL_MIN_MS = 250;
const DONE_POLL_MAX_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** Register this process's port with the environment, retrying inside the boot budget. */
async function register(envUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const { status } = await fetchJson(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      // 200 is a fresh registration; 409 means an earlier attempt already won.
      if (status === 200 || status === 201 || status === 409) return;
      console.error(`[forge] register attempt ${attempt}: HTTP ${status}`);
    } catch (err) {
      console.error(`[forge] register attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
    }
    if (Date.now() + REGISTER_RETRY_MS > deadline) {
      throw new Error('could not register with the environment within the boot budget');
    }
    await sleep(REGISTER_RETRY_MS);
  }
}

/** Long-poll $MAKEFUN_ENV_URL/done until it answers {"done": true}, then return. */
async function waitForDone(envUrl: string): Promise<void> {
  let interval = DONE_POLL_MIN_MS;
  for (;;) {
    try {
      const { body } = await fetchJson(`${envUrl}/done`);
      const done = (body as { done?: unknown } | null)?.done === true;
      if (done) return;
    } catch (err) {
      console.error(`[forge] /done poll failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(interval);
    interval = Math.min(DONE_POLL_MAX_MS, interval * 2);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  const server = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) throw new Error('failed to bind an ephemeral port');
  console.error(`[forge] listening on 127.0.0.1:${port}`);

  if (envUrl === undefined || envUrl === '') {
    console.error('[forge] MAKEFUN_ENV_URL is not set; running until stopped');
    // Local development: stop cleanly on SIGTERM/SIGINT instead of being killed mid-request.
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        server.closeAllConnections();
        server.close();
        resolve();
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    });
    return;
  }
  await register(envUrl, port);
  console.error('[forge] registered with the environment');
  await waitForDone(envUrl);
  console.error('[forge] done; exiting');
  server.closeAllConnections();
  server.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`[forge] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
