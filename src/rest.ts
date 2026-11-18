// REST v3: the /api/v3 surface. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors carry {message}; a repo under any owner other than
// the viewer is a 404, never a 403; an unknown route is a 404; a malformed JSON
// body is a 400; a missing or wrong token is a 401.
//
// The serializers here are also the shapes MCP returns, so the two surfaces read
// back identical objects.

import {
  emptyResponse,
  isAuthorized,
  jsonError,
  jsonResponse,
  jsonResponseRaw,
  paginate,
  paginationLink,
  parseJsonBody,
  queryInt,
  type HttpResponse,
  type RequestContext,
} from './http.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  parseCommit,
} from './gitobj.ts';
import {
  FIXED_ISO,
  addComment,
  commitOnBranch,
  commitTree,
  createIssue,
  createPull,
  createRepo,
  defaultTip,
  deleteRepo,
  diffTrees,
  getRepo,
  globalId,
  listRepos,
  nextCommitTimestamp,
  planMerge,
  putObject,
  readTreePath,
  resolveRef,
  shortBranch,
  updateTree,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { VIEWER, VIEWER_LOGIN } from './scenario.ts';

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 1,
    node_id: globalId('User', login),
    avatar_url: '',
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.userLogin),
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The issue's serialized REST JSON, cached on the issue and rebuilt on mutation. */
export function issueJsonString(repo: Repo, issue: Issue): string {
  if (issue.jsonCache === null) issue.jsonCache = JSON.stringify(issueJson(repo, issue));
  return issue.jsonCache;
}

export function commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: pull.merged ? null : mergeableNow(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip ?? ZERO_OID,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip ?? ZERO_OID,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    user: userJson(pull.userLogin),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function pullJsonString(repo: Repo, pull: Pull): string {
  if (pull.jsonCache === null) pull.jsonCache = JSON.stringify(pullJson(repo, pull));
  return pull.jsonCache;
}

/** Whether a pull request would merge cleanly right now. */
export function mergeableNow(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  return !planMerge(repo, baseTip, headTip).conflicted;
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  let parsed;
  try {
    parsed = parseCommit(object.data);
  } catch {
    return null;
  }
  const identity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: FIXED_ISO };
    return { name: match[1] as string, email: match[2] as string, date: FIXED_ISO };
  };
  return {
    sha,
    commit: {
      // GitHub's API reports the message without the trailing newline git stores.
      message: parsed.message.replace(/\n+$/, ''),
      author: identity(parsed.author),
      committer: identity(parsed.committer),
    },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function bodyObject(ctx: RequestContext): Record<string, unknown> | null {
  const parsed = parseJsonBody(ctx);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** The repository a /repos/{owner}/{repo}/... route names, or a 404 response. */
function routeRepo(ctx: RequestContext, owner: string, name: string): Repo | HttpResponse {
  if (owner !== VIEWER_LOGIN) return jsonError(404, 'Not Found');
  const repo = getRepo(name);
  if (repo === undefined) return jsonError(404, 'Not Found');
  return repo;
}

/** The issue or pull request a number names, or null. */
function routeNumber(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) return null;
  return parsed;
}

/** Invalidate the cached serializations that a change to a repo's refs touches. */
export function invalidatePullCaches(repo: Repo): void {
  for (const pull of repo.pulls.values()) pull.jsonCache = null;
}

function invalidateIssueCache(issue: Issue): void {
  issue.jsonCache = null;
}

// ---------------------------------------------------------------------------
// /api/v3 root, meta, user, user/repos
// ---------------------------------------------------------------------------

function handleRoot(ctx: RequestContext): HttpResponse {
  return jsonResponse(
    200,
    {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleMeta(): HttpResponse {
  return jsonResponse(200, {
    installed_version: '1.0.0',
    verifiable_password_authentication: true,
    ssh_key_fingerprints: {},
  });
}

function handleUser(): HttpResponse {
  return jsonResponse(200, {
    ...userJson(VIEWER.login),
    name: VIEWER.name,
    email: VIEWER.email,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  });
}

function handleListUserRepos(ctx: RequestContext): HttpResponse {
  const perPage = queryInt(ctx, 'per_page', 30, 1, 100);
  const page = queryInt(ctx, 'page', 1, 1, 1_000_000);
  const repos = listRepos();
  const link = paginationLink(ctx, page, perPage, repos.length);
  const headers: Record<string, string> = {};
  if (link !== null) headers['link'] = link;
  return jsonResponse(200, paginate(repos, page, perPage).map(repoJson), headers);
}

function handleCreateRepo(ctx: RequestContext): HttpResponse {
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const name = asString(body['name']);
  if (name === null || name === '' || name.includes('/') || name.includes(' ') || name.includes('\0')) {
    return jsonError(422, 'name is required and must be a valid repository name');
  }
  if (getRepo(name) !== undefined) {
    return jsonError(422, `Repository ${VIEWER.login}/${name} already exists`);
  }
  const repo = createRepo(name, {
    description: asString(body['description']) ?? '',
    private: asBoolean(body['private']) ?? false,
  });
  return jsonResponse(201, repoJson(repo));
}

// ---------------------------------------------------------------------------
// /api/v3/repos/{owner}/{repo}
// ---------------------------------------------------------------------------

function handleGetRepo(repo: Repo): HttpResponse {
  return jsonResponse(200, repoJson(repo));
}

function handlePatchRepo(ctx: RequestContext, repo: Repo): HttpResponse {
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const description = asString(body['description']);
  if (description !== null) repo.description = description;
  const isPrivate = asBoolean(body['private']);
  if (isPrivate !== null) repo.private = isPrivate;
  return jsonResponse(200, repoJson(repo));
}

function handleDeleteRepo(repo: Repo): HttpResponse {
  deleteRepo(repo.name);
  return emptyResponse(204);
}

function handleListBranches(repo: Repo): HttpResponse {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push(branchJson(repo, ref.slice('refs/heads/'.length), oid));
  }
  return jsonResponse(200, branches);
}

function handleGetBranch(repo: Repo, branch: string): HttpResponse {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return jsonError(404, 'Branch not found');
  return jsonResponse(200, branchJson(repo, branch, oid));
}

function handleGetRef(repo: Repo, refPath: string): HttpResponse {
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return jsonError(404, 'Reference does not exist');
  const object = repo.objects.get(oid);
  return jsonResponse(200, {
    ref,
    node_id: globalId('Ref', `${repo.id}:${ref}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice('refs/'.length)}`,
    object: { sha: oid, type: object?.type ?? 'commit', url: '' },
  });
}

function handleCreateRef(ctx: RequestContext, repo: Repo): HttpResponse {
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const ref = asString(body['ref']);
  const sha = asString(body['sha']);
  if (ref === null || !ref.startsWith('refs/') || sha === null) {
    return jsonError(422, 'ref and sha are required');
  }
  const object = repo.objects.get(sha);
  if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
    return jsonError(422, 'sha does not name a commit or tag');
  }
  if (repo.refs.has(ref)) return jsonError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  repo.version += 1;
  repo.packCache.clear();
  invalidatePullCaches(repo);
  return jsonResponse(201, {
    ref,
    node_id: globalId('Ref', `${repo.id}:${ref}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice('refs/'.length)}`,
    object: { sha, type: object.type, url: '' },
  });
}

function handleListCommits(ctx: RequestContext, repo: Repo): HttpResponse {
  const perPage = queryInt(ctx, 'per_page', 30, 1, 100);
  const page = queryInt(ctx, 'page', 1, 1, 1_000_000);
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return jsonError(404, 'No commit found for that ref');
  const order: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    order.push(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    } catch {
      // ignore
    }
  }
  const items: Array<Record<string, unknown>> = [];
  for (const oid of paginate(order, page, perPage)) {
    const rendered = commitJson(repo, oid);
    if (rendered !== null) items.push(rendered);
  }
  const link = paginationLink(ctx, page, perPage, order.length);
  return jsonResponse(200, items, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function resolveBranchForWrite(repo: Repo, requested: string | null): string {
  const branch = requested ?? repo.defaultBranch;
  if (repo.refs.has(`refs/heads/${branch}`)) return branch;
  // The branch does not exist yet: start it from the default branch's tip, the
  // way the contents API is used to open a new branch from a write.
  const tip = defaultTip(repo);
  if (tip !== null) {
    repo.refs.set(`refs/heads/${branch}`, tip);
    repo.version += 1;
    repo.packCache.clear();
    return branch;
  }
  return branch;
}

function handleGetContents(ctx: RequestContext, repo: Repo, path: string): HttpResponse {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return jsonError(404, 'Not Found');
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return jsonError(404, 'Not Found');
  const found = readTreePath(repo, treeOid, path);
  if (found === null) return jsonError(404, 'Not Found');
  const baseUrl = `/api/v3/repos/${repo.owner}/${repo.name}/contents`;
  if (found.kind === 'file') {
    const object = repo.objects.get(found.oid);
    if (!object || object.type !== 'blob') return jsonError(404, 'Not Found');
    const name = path.split('/').filter(Boolean).pop() ?? '';
    return jsonResponse(200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name,
      path,
      content: object.data.toString('base64'),
      sha: found.oid,
      url: `${baseUrl}/${path}`,
    });
  }
  const entries = found.entries.map((entry) => {
    const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const size = entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
    return {
      type: entry.mode === '40000' ? 'dir' : 'file',
      size,
      name: entry.name,
      path: entryPath,
      sha: entry.oid,
      url: `${baseUrl}/${entryPath}`,
    };
  });
  return jsonResponse(200, entries);
}

function handlePutContents(ctx: RequestContext, repo: Repo, path: string): HttpResponse {
  if (path === '') return jsonError(400, 'path is required');
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const encoded = asString(body['content']);
  if (encoded === null) return jsonError(400, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
  } catch {
    return jsonError(400, 'content is not valid base64');
  }
  const message = asString(body['message']) ?? `Update ${path}`;
  const branch = resolveBranchForWrite(repo, asString(body['branch']));
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const treeOid = tip === undefined ? null : commitTree(repo, tip);
  const existing = treeOid === null ? null : readTreePath(repo, treeOid, path);
  const isUpdate = existing !== null && existing.kind === 'file';
  if (existing !== null && existing.kind === 'dir') return jsonError(409, 'path names a directory');
  if (isUpdate) {
    const expected = asString(body['sha']);
    if (expected === null) return jsonError(422, 'sha is required to update a file');
    if (expected !== existing.oid) return jsonError(409, 'sha does not match the current file');
  }
  const blobOid = putObject(repo, 'blob', content);
  const newTree = updateTree(repo, treeOid, path, blobOid);
  const commitOid = commitOnBranch(repo, branch, newTree, message);
  invalidatePullCaches(repo);
  const name = path.split('/').filter(Boolean).pop() ?? '';
  return jsonResponse(isUpdate ? 200 : 201, {
    content: {
      name,
      path,
      sha: blobOid,
      size: content.length,
      encoding: 'base64',
      type: 'file',
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    },
    commit: { sha: commitOid, message, node_id: globalId('Commit', `${repo.id}:${commitOid}`) },
  });
}

function handleDeleteContents(ctx: RequestContext, repo: Repo, path: string): HttpResponse {
  if (path === '') return jsonError(400, 'path is required');
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const message = asString(body['message']) ?? `Delete ${path}`;
  const branch = asString(body['branch']) ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return jsonError(404, 'Not Found');
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return jsonError(404, 'Not Found');
  const existing = readTreePath(repo, treeOid, path);
  if (existing === null || existing.kind !== 'file') return jsonError(404, 'Not Found');
  const expected = asString(body['sha']);
  if (expected !== null && expected !== existing.oid) return jsonError(409, 'sha does not match the current file');
  const newTree = updateTree(repo, treeOid, path, null);
  const commitOid = commitOnBranch(repo, branch, newTree, message);
  invalidatePullCaches(repo);
  return jsonResponse(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------
// labels, issues, comments
// ---------------------------------------------------------------------------

function handleListLabels(repo: Repo): HttpResponse {
  return jsonResponse(200, [...repo.labels.values()].map(labelJson));
}

function handleCreateLabel(ctx: RequestContext, repo: Repo): HttpResponse {
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const name = asString(body['name']);
  if (name === null || name === '') return jsonError(422, 'name is required');
  const color = asString(body['color']) ?? 'ededed';
  const existing = repo.labels.get(name);
  if (existing !== undefined) return jsonResponse(201, labelJson(existing));
  const label: Label = { name, color, description: asString(body['description']) ?? '' };
  repo.labels.set(name, label);
  return jsonResponse(201, labelJson(label));
}

function resolveLabels(repo: Repo, raw: unknown): { labels: Label[]; error: string | null } {
  if (raw === undefined || raw === null) return { labels: [], error: null };
  if (!Array.isArray(raw)) return { labels: [], error: 'labels must be an array' };
  const labels: Label[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : (item as Record<string, unknown>)?.['name'];
    if (typeof name !== 'string') return { labels: [], error: 'label names must be strings' };
    const label = repo.labels.get(name);
    if (label === undefined) return { labels: [], error: `label "${name}" does not exist` };
    labels.push(label);
  }
  return { labels, error: null };
}

function handleCreateIssue(ctx: RequestContext, repo: Repo): HttpResponse {
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const title = asString(body['title']);
  if (title === null || title === '') return jsonError(422, 'title is required');
  const { labels, error } = resolveLabels(repo, body['labels']);
  if (error !== null) return jsonError(422, error);
  const issue = createIssue(repo, title, asString(body['body']) ?? '', labels);
  return jsonResponseRaw(201, issueJsonString(repo, issue));
}

function handleListIssues(ctx: RequestContext, repo: Repo): HttpResponse {
  const perPage = queryInt(ctx, 'per_page', 30, 1, 100);
  const page = queryInt(ctx, 'page', 1, 1, 1_000_000);
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') return jsonError(422, 'state must be open, closed or all');
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const link = paginationLink(ctx, page, perPage, issues.length);
  const headers: Record<string, string> = {};
  if (link !== null) headers['link'] = link;
  return jsonResponse(200, paginate(issues, page, perPage).map((issue) => issueJson(repo, issue)), headers);
}

function handleGetIssue(repo: Repo, number: number): HttpResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return jsonError(404, 'Not Found');
  return jsonResponseRaw(200, issueJsonString(repo, issue));
}

function handlePatchIssue(ctx: RequestContext, repo: Repo, number: number): HttpResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return jsonError(404, 'Not Found');
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const title = asString(body['title']);
  if (title !== null) issue.title = title;
  const bodyText = asString(body['body']);
  if (bodyText !== null) issue.body = bodyText;
  const state = asString(body['state']);
  if (state !== null) {
    if (state !== 'open' && state !== 'closed') return jsonError(422, 'state must be open or closed');
    issue.state = state;
  }
  if (body['labels'] !== undefined) {
    const { labels, error } = resolveLabels(repo, body['labels']);
    if (error !== null) return jsonError(422, error);
    issue.labels = labels;
  }
  invalidateIssueCache(issue);
  return jsonResponseRaw(200, issueJsonString(repo, issue));
}

function handleListComments(repo: Repo, number: number): HttpResponse {
  if (!repo.issues.has(number) && !repo.pulls.has(number)) return jsonError(404, 'Not Found');
  return jsonResponse(200, (repo.comments.get(number) ?? []).map((comment) => commentJson(repo, comment)));
}

function handleCreateComment(ctx: RequestContext, repo: Repo, number: number): HttpResponse {
  if (!repo.issues.has(number) && !repo.pulls.has(number)) return jsonError(404, 'Not Found');
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const text = asString(body['body']);
  if (text === null) return jsonError(422, 'body is required');
  const comment = addComment(repo, number, text);
  const issue = repo.issues.get(number);
  if (issue !== undefined) invalidateIssueCache(issue);
  return jsonResponse(201, commentJson(repo, comment));
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handleCreatePull(ctx: RequestContext, repo: Repo): HttpResponse {
  const body = bodyObject(ctx);
  if (body === null) return jsonError(400, 'Malformed JSON body');
  const title = asString(body['title']);
  const head = asString(body['head']);
  const base = asString(body['base']);
  if (title === null || title === '') return jsonError(422, 'title is required');
  if (head === null || head === '') return jsonError(422, 'head is required');
  if (base === null || base === '') return jsonError(422, 'base is required');
  const headRef = shortBranch(head);
  const baseRef = shortBranch(base);
  if (repo.refs.get(`refs/heads/${headRef}`) === undefined) return jsonError(422, 'head branch does not exist');
  if (repo.refs.get(`refs/heads/${baseRef}`) === undefined) return jsonError(422, 'base branch does not exist');
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return jsonError(422, 'a pull request already exists for this head and base');
    }
  }
  const pull = createPull(repo, title, asString(body['body']) ?? '', headRef, baseRef);
  return jsonResponseRaw(201, pullJsonString(repo, pull));
}

function handleListPulls(ctx: RequestContext, repo: Repo): HttpResponse {
  const perPage = queryInt(ctx, 'per_page', 30, 1, 100);
  const page = queryInt(ctx, 'page', 1, 1, 1_000_000);
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') return jsonError(422, 'state must be open, closed or all');
  pulls.sort((a, b) => b.number - a.number);
  const link = paginationLink(ctx, page, perPage, pulls.length);
  const headers: Record<string, string> = {};
  if (link !== null) headers['link'] = link;
  return jsonResponse(200, paginate(pulls, page, perPage).map((pull) => pullJson(repo, pull)), headers);
}

function handleGetPull(repo: Repo, number: number): HttpResponse {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return jsonError(404, 'Not Found');
  return jsonResponseRaw(200, pullJsonString(repo, pull));
}

function handleListPullFiles(repo: Repo, number: number): HttpResponse {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return jsonError(404, 'Not Found');
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return jsonError(422, 'branch not found');
  const headTree = commitTree(repo, headTip);
  const baseTree = commitTree(repo, baseTip);
  const files = diffTrees(repo, baseTree, headTree).map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  }));
  return jsonResponse(200, files);
}

/** Squash-merge a pull request onto its base branch. Returns the squash commit's oid, or an error response. */
export function mergePullRequest(repo: Repo, pull: Pull): { sha: string } | HttpResponse {
  if (pull.merged) return jsonError(405, 'pull request is already merged');
  if (pull.state !== 'open') return jsonError(405, 'pull request is closed');
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return jsonError(422, 'branch not found');
  const plan = planMerge(repo, baseTip, headTip);
  if (plan.conflicted) return jsonError(405, 'merge conflict');
  const mergedTree = plan.treeOid ?? commitTree(repo, baseTip) ?? putObject(repo, 'tree', buildTree([]));
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const timestamp = nextCommitTimestamp();
  const data = buildCommit({
    tree: mergedTree,
    parents: [baseTip],
    message: `${pull.title} (#${pull.number})\n`,
    author: identity,
    committer: identity,
    timestamp,
  });
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.version += 1;
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = sha;
  pull.jsonCache = null;
  invalidatePullCaches(repo);
  return { sha };
}

function handleMergePull(ctx: RequestContext, repo: Repo, number: number): HttpResponse {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return jsonError(404, 'Not Found');
  if (ctx.body.length > 0) {
    const body = parseJsonBody(ctx);
    if (body === null || typeof body !== 'object') return jsonError(400, 'Malformed JSON body');
  }
  const result = mergePullRequest(repo, pull);
  if ('status' in result) return result;
  return jsonResponse(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RequestContext): HttpResponse {
  if (!isAuthorized(ctx)) return jsonError(401, 'Unauthorized');
  const segments = ctx.segments;
  if (segments.length === 0) {
    return ctx.method === 'GET' ? handleRoot(ctx) : jsonError(404, 'Not Found');
  }
  if (segments[0] === 'meta') {
    return ctx.method === 'GET' ? handleMeta() : jsonError(404, 'Not Found');
  }
  if (segments[0] === 'user') {
    if (segments.length === 1) return ctx.method === 'GET' ? handleUser() : jsonError(404, 'Not Found');
    if (segments[1] === 'repos' && segments.length === 2) {
      if (ctx.method === 'GET') return handleListUserRepos(ctx);
      if (ctx.method === 'POST') return handleCreateRepo(ctx);
    }
    return jsonError(404, 'Not Found');
  }
  if (segments[0] !== 'repos' || segments.length < 3) return jsonError(404, 'Not Found');
  const repoOrError = routeRepo(ctx, segments[1] as string, segments[2] as string);
  if ('status' in repoOrError) return repoOrError;
  const repo = repoOrError;
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (ctx.method === 'GET') return handleGetRepo(repo);
    if (ctx.method === 'PATCH') return handlePatchRepo(ctx, repo);
    if (ctx.method === 'DELETE') return handleDeleteRepo(repo);
    return jsonError(404, 'Not Found');
  }
  const head = rest[0] as string;
  if (head === 'branches') {
    if (rest.length === 1) return ctx.method === 'GET' ? handleListBranches(repo) : jsonError(404, 'Not Found');
    const branch = rest.slice(1).join('/');
    return ctx.method === 'GET' ? handleGetBranch(repo, branch) : jsonError(404, 'Not Found');
  }
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) return ctx.method === 'POST' ? handleCreateRef(ctx, repo) : jsonError(404, 'Not Found');
    if (rest.length >= 3 && ctx.method === 'GET') return handleGetRef(repo, rest.slice(2).join('/'));
    return jsonError(404, 'Not Found');
  }
  if (head === 'commits') {
    return ctx.method === 'GET' ? handleListCommits(ctx, repo) : jsonError(404, 'Not Found');
  }
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (ctx.method === 'GET') return handleGetContents(ctx, repo, path);
    if (ctx.method === 'PUT') return handlePutContents(ctx, repo, path);
    if (ctx.method === 'DELETE') return handleDeleteContents(ctx, repo, path);
    return jsonError(404, 'Not Found');
  }
  if (head === 'labels') {
    if (rest.length !== 1) return jsonError(404, 'Not Found');
    if (ctx.method === 'GET') return handleListLabels(repo);
    if (ctx.method === 'POST') return handleCreateLabel(ctx, repo);
    return jsonError(404, 'Not Found');
  }
  if (head === 'issues') {
    if (rest.length === 1) {
      if (ctx.method === 'GET') return handleListIssues(ctx, repo);
      if (ctx.method === 'POST') return handleCreateIssue(ctx, repo);
      return jsonError(404, 'Not Found');
    }
    const number = routeNumber(rest[1] as string);
    if (number === null) return jsonError(404, 'Not Found');
    if (rest.length === 2) {
      if (ctx.method === 'GET') return handleGetIssue(repo, number);
      if (ctx.method === 'PATCH') return handlePatchIssue(ctx, repo, number);
      return jsonError(404, 'Not Found');
    }
    if (rest[2] === 'comments' && rest.length === 3) {
      if (ctx.method === 'GET') return handleListComments(repo, number);
      if (ctx.method === 'POST') return handleCreateComment(ctx, repo, number);
    }
    return jsonError(404, 'Not Found');
  }
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (ctx.method === 'GET') return handleListPulls(ctx, repo);
      if (ctx.method === 'POST') return handleCreatePull(ctx, repo);
      return jsonError(404, 'Not Found');
    }
    const number = routeNumber(rest[1] as string);
    if (number === null) return jsonError(404, 'Not Found');
    if (rest.length === 2) {
      return ctx.method === 'GET' ? handleGetPull(repo, number) : jsonError(404, 'Not Found');
    }
    if (rest[2] === 'files' && rest.length === 3) {
      return ctx.method === 'GET' ? handleListPullFiles(repo, number) : jsonError(404, 'Not Found');
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      return ctx.method === 'PUT' ? handleMergePull(ctx, repo, number) : jsonError(404, 'Not Found');
    }
    return jsonError(404, 'Not Found');
  }
  return jsonError(404, 'Not Found');
}
