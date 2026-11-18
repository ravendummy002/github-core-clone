// MCP at POST /mcp: JSON-RPC 2.0 over Streamable HTTP. The modern handshake is
// server/discover (revision 2026-07-28); the legacy initialize +
// notifications/initialized handshake is supported as a fallback. Six tools act on
// the same in-memory store as REST, so a tool's objects read back over /api/v3
// with unchanged ids. tools/list is built once at startup, so two calls answer
// byte-identical lists.

import {
  jsonError,
  jsonResponse,
  isAuthorized,
  parseJsonBody,
  type HttpResponse,
  type RequestContext,
} from './http.ts';
import {
  createIssue,
  createPull,
  createRepo,
  getRepo,
  type Repo,
} from './store.ts';
import { issueJson, mergePullRequest, pullJson, repoJson } from './rest.ts';
import { VIEWER_LOGIN } from './scenario.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
const LEGACY_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The tool list, built once: two tools/list calls answer byte-identical lists. */
const TOOLS: readonly Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch the changes come from.' },
        base: { type: 'string', description: 'The branch the changes go into.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: RpcId, code: number, message: string, httpStatus = 200): HttpResponse {
  return jsonResponse(httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

/** A tool result: human-readable JSON text plus the structured object. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Resolve an owner/repo pair (or a "owner/repo" full_name) to a repository, or null. */
function resolveRepo(args: Record<string, unknown>): Repo | null {
  let owner = asString(args['owner']);
  let name = asString(args['repo']);
  const fullName = asString(args['full_name']);
  if ((owner === null || name === null) && fullName !== null) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner = fullName.slice(0, slash);
      name = fullName.slice(slash + 1);
    }
  }
  if (owner === null || name === null) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(name) ?? null;
}

/**
 * Dispatch one tools/call. Returns either a tool result or, for a bad call,
 * an object describing the JSON-RPC error to send.
 */
function callTool(name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { error: { code: -32602, message: `unknown tool ${name}` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: { code: -32602, message: `missing required argument ${required}` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args['name']) as string;
      if (getRepo(repoName) !== undefined) return { result: toolFailure(`Repository ${repoName} already exists`) };
      const repo = createRepo(repoName, {
        description: asString(args['description']) ?? '',
        private: typeof args['private'] === 'boolean' ? args['private'] : false,
      });
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = resolveRepo(args);
      if (repo === null) return { result: toolFailure('repository not found') };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = resolveRepo(args);
      if (repo === null) return { result: toolFailure('repository not found') };
      const title = asString(args['title']) as string;
      const issue = createIssue(repo, title, asString(args['body']) ?? '', []);
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = resolveRepo(args);
      if (repo === null) return { result: toolFailure('repository not found') };
      const state = asString(args['state']) ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      const rendered = issues.map((issue) => issueJson(repo, issue));
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(rendered) }],
          structuredContent: { issues: rendered },
        },
      };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(args);
      if (repo === null) return { result: toolFailure('repository not found') };
      const head = asString(args['head']) as string;
      const base = asString(args['base']) as string;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return { result: toolFailure('head branch does not exist') };
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return { result: toolFailure('base branch does not exist') };
      const pull = createPull(repo, asString(args['title']) as string, asString(args['body']) ?? '', head, base);
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(args);
      if (repo === null) return { result: toolFailure('repository not found') };
      const number = asNumber(args['pull_number']);
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (pull === undefined) return { result: toolFailure('pull request not found') };
      const outcome = mergePullRequest(repo, pull);
      if ('status' in outcome) return { result: toolFailure('pull request cannot be merged') };
      return {
        result: toolResult({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', pull_number: pull.number }),
      };
    }
    default:
      return { error: { code: -32602, message: `unknown tool ${name}` } };
  }
}

function handleRequest(request: Record<string, unknown>): HttpResponse | null {
  const id = (request['id'] ?? null) as RpcId;
  const method = request['method'];
  if (typeof method !== 'string') return rpcError(id, -32600, 'method must be a string');
  if (method.startsWith('notifications/')) {
    // Notifications carry no id and get an empty 202.
    return null;
  }
  const params = (request['params'] ?? {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
    const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
    const outcome = callTool(toolName, args);
    if ('error' in outcome) return rpcError(id, outcome.error.code, outcome.error.message);
    return rpcResult(id, outcome.result);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

export function handleMcp(ctx: RequestContext): HttpResponse {
  if (!isAuthorized(ctx)) return jsonError(401, 'Unauthorized');
  if (ctx.method !== 'POST') return jsonError(405, 'Method Not Allowed');
  const body = parseJsonBody(ctx);
  if (body === null) {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(body)) {
    const responses: unknown[] = [];
    for (const entry of body) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      const response = handleRequest(entry as Record<string, unknown>);
      if (response !== null) responses.push(JSON.parse(response.body.toString('utf8')) as unknown);
    }
    return jsonResponse(200, responses);
  }
  if (typeof body !== 'object') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const response = handleRequest(body as Record<string, unknown>);
  if (response === null) {
    // A notification: an empty 202.
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }
  return response;
}
