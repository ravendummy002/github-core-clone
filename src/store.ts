// The forge's whole state, in memory: repositories with their git objects and refs,
// issues, pull requests, labels and comments. Nothing here touches the disk or the
// clock — every stored timestamp is a fixed constant or a deterministic counter, so
// two runs on the same requests leave byte-identical state.
//
// Identity: every repository belongs to the viewer login the scenario seed names
// (src/scenario.ts). The store keys repositories by name alone; the surfaces check
// the owner against that login and answer 404 for any other.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';

/** The one timestamp every created_at/updated_at/merged_at carries: fixed, never the wall clock. */
export const FIXED_ISO = '2025-01-01T00:00:00Z';
/** The epoch commit timestamps start from; each commit takes the next second. */
const COMMIT_EPOCH_SEC = 1_700_000_000;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  /** Serialized REST JSON, rebuilt whenever the issue changes (the read workload's fast path). */
  jsonCache: string | null;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  jsonCache: string | null;
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  /** Bumped on every git mutation; fetch-pack cache keys include it. */
  version: number;
  /** Fetch-pack cache: request signature -> the pack and its shallow lines. */
  packCache: Map<string, CachedFetch>;
  createdAt: string;
}

/** One cached fetch result: the pack bytes plus the shallow/unshallow lines that go with it. */
export interface CachedFetch {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/** Opaque Relay-style global ids: base64 of a typed key, stable across reads. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

let nextRepoId = 1;
let nextGlobalId = 1;
let commitCounter = 0;

const repos = new Map<string, Repo>();

export function getRepo(name: string): Repo | undefined {
  return repos.get(name);
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function createRepo(name: string, options: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
  const id = nextRepoId++;
  const repo: Repo = {
    id,
    nodeId: globalId('Repository', String(id)),
    name,
    owner: VIEWER.login,
    description: options.description ?? '',
    private: options.private ?? false,
    defaultBranch: options.defaultBranch ?? 'main',
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    comments: new Map(),
    nextNumber: 1,
    version: 0,
    packCache: new Map(),
    createdAt: FIXED_ISO,
  };
  repos.set(name, repo);
  return repo;
}

export function deleteRepo(name: string): boolean {
  return repos.delete(name);
}

/** The next deterministic commit timestamp (seconds), one second per commit, ever. */
export function nextCommitTimestamp(): number {
  commitCounter += 1;
  return COMMIT_EPOCH_SEC + commitCounter;
}

/** The identity every forge-made commit carries: the viewer's name and email. */
export function forgeIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

/** Store an object, returning its id. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The default branch's tip, or null when the repository is unborn. */
export function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.objects.has(ref)) {
    const object = repo.objects.get(ref) as GitObject;
    if (object.type === 'commit') return ref;
    if (object.type === 'tag') return peelTag(repo, ref);
    return null;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return peelToCommit(repo, direct);
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return peelToCommit(repo, branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(repo, tag);
  return null;
}

/** Peel a tag object (or a chain of them) to the commit it points at. */
export function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    try {
      current = parseTag(object.data).object;
    } catch {
      return null;
    }
  }
}

export function peelToCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') return peelTag(repo, oid);
  return null;
}

/** True when `ancestor` is reachable from `oid` by following parents (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue: string[] = [oid];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    let parents: string[];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      continue;
    }
    for (const parent of parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Every object reachable from `roots` (commits, trees, blobs, tags). */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      try {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } catch {
        // a malformed commit contributes nothing further
      }
    } else if (object.type === 'tag') {
      try {
        queue.push(parseTag(object.data).object);
      } catch {
        // ignore
      }
    } else if (object.type === 'tree') {
      try {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue; // a gitlink names a commit this repo does not hold
          queue.push(entry.oid);
        }
      } catch {
        // ignore
      }
    }
  }
  return seen;
}

/** The tree of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  try {
    return parseCommit(object.data).tree;
  } catch {
    return null;
  }
}

/** Flatten a tree into path -> {oid, mode}, walking subdirectories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    let entries: TreeEntry[];
    try {
      entries = parseTree(object.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Read one path out of a tree: the blob entry, a directory's entries, or null when absent. */
export function readTreePath(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    let entries: TreeEntry[];
    try {
      entries = parseTree(object.data);
    } catch {
      return null;
    }
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      if (entry.mode === '40000') {
        const dir = repo.objects.get(entry.oid);
        if (!dir || dir.type !== 'tree') return null;
        try {
          return { kind: 'dir', entries: parseTree(dir.data) };
        } catch {
          return null;
        }
      }
      return { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  // An empty path names the root tree itself.
  const root = repo.objects.get(current);
  if (!root || root.type !== 'tree') return null;
  try {
    return { kind: 'dir', entries: parseTree(root.data) };
  } catch {
    return null;
  }
}

/**
 * A new tree with `path` set to `blobOid` (or removed when `blobOid` is null), built from
 * `baseTreeOid` (or an empty tree). Intermediate directories are created or pruned as needed.
 */
export function updateTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((segment) => segment !== '');

  const rebuild = (treeOid: string | null, depth: number): string | null => {
    let entries: TreeEntry[] = [];
    if (treeOid !== null) {
      const object = repo.objects.get(treeOid);
      if (object && object.type === 'tree') {
        try {
          entries = parseTree(object.data);
        } catch {
          entries = [];
        }
      }
    }
    const name = segments[depth] as string;
    const isLeaf = depth === segments.length - 1;
    const next = entries.filter((entry) => entry.name !== name);
    if (isLeaf) {
      if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.find((entry) => entry.name === name);
      const childOid = rebuild(child && child.mode === '40000' ? child.oid : null, depth + 1);
      if (childOid !== null) next.push({ mode: '40000', name, oid: childOid });
    }
    if (next.length === 0) return null;
    return putObject(repo, 'tree', buildTree(next));
  };

  const rebuilt = rebuild(baseTreeOid, 0);
  if (rebuilt !== null) return rebuilt;
  return putObject(repo, 'tree', buildTree([]));
}

/** Create a commit on `branch` (creating the branch when absent) and move the ref to it. */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const identity = forgeIdentity();
  const timestamp = nextCommitTimestamp();
  const data = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: identity,
    committer: identity,
    timestamp,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  repo.version += 1;
  repo.packCache.clear();
  return oid;
}

/** The first common ancestor of two commits (the merge base), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const current = queueA.pop() as string;
    if (ancestorsA.has(current)) continue;
    ancestorsA.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    } catch {
      // ignore
    }
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const current = queueB.pop() as string;
    if (seenB.has(current)) continue;
    seenB.add(current);
    if (ancestorsA.has(current)) return current;
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    } catch {
      // ignore
    }
  }
  return null;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count added/removed lines between two blob contents with a simple LCS diff. */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) {
    const lines = newData!.toString('utf8').split('\n');
    return { additions: lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, deletions: 0 };
  }
  if (newData === null) {
    const lines = oldData.toString('utf8').split('\n');
    return { additions: 0, deletions: lines[lines.length - 1] === '' ? lines.length - 1 : lines.length };
  }
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  // LCS lengths, one row at a time; files here are small.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const common = prev[newLines.length] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function blobData(repo: Repo, oid: string | null): Buffer | null {
  if (oid === null) return null;
  const object = repo.objects.get(oid);
  return object && object.type === 'blob' ? object.data : null;
}

/** The files that differ between two trees, with line counts. */
export function diffTrees(repo: Repo, oldTreeOid: string | null, newTreeOid: string | null): ChangedFile[] {
  const oldFiles = oldTreeOid === null ? new Map() : flattenTree(repo, oldTreeOid);
  const newFiles = newTreeOid === null ? new Map() : flattenTree(repo, newTreeOid);
  const paths = new Set<string>([...oldFiles.keys(), ...newFiles.keys()]);
  const out: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    if (oldEntry && !newEntry) {
      const counts = lineDiff(blobData(repo, oldEntry.oid), null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (!oldEntry && newEntry) {
      const counts = lineDiff(null, blobData(repo, newEntry.oid));
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (oldEntry && newEntry) {
      const counts = lineDiff(blobData(repo, oldEntry.oid), blobData(repo, newEntry.oid));
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return out;
}

export interface MergePlan {
  conflicted: boolean;
  /** The merged tree oid, when the merge is clean. */
  treeOid: string | null;
  /** Paths that conflict, when conflicted. */
  conflicts: string[];
}

/**
 * A three-way merge of `headTip` onto `baseTip` with their merge base: every path the head
 * changed (against the base) is applied to the base tree, unless the base changed the same
 * path to something different — that is a conflict.
 */
export function planMerge(repo: Repo, baseTip: string, headTip: string): MergePlan {
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const baseTipTree = commitTree(repo, baseTip);
  const headTipTree = commitTree(repo, headTip);
  const baseFiles = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const baseTipFiles = baseTipTree === null ? new Map() : flattenTree(repo, baseTipTree);
  const headTipFiles = headTipTree === null ? new Map() : flattenTree(repo, headTipTree);
  const conflicts: string[] = [];
  let mergedTree = baseTipTree;
  const paths = new Set<string>([...baseFiles.keys(), ...baseTipFiles.keys(), ...headTipFiles.keys()]);
  for (const path of paths) {
    const ancestorOid = baseFiles.get(path)?.oid ?? null;
    const baseOid = baseTipFiles.get(path)?.oid ?? null;
    const headOid = headTipFiles.get(path)?.oid ?? null;
    const headChanged = headOid !== ancestorOid;
    const baseChanged = baseOid !== ancestorOid;
    if (!headChanged) continue;
    if (baseChanged && baseOid !== headOid) {
      conflicts.push(path);
      continue;
    }
    mergedTree = updateTree(repo, mergedTree, path, headOid);
  }
  if (conflicts.length > 0) return { conflicted: true, treeOid: null, conflicts };
  return { conflicted: false, treeOid: mergedTree, conflicts: [] };
}

// ---------------------------------------------------------------------------
// issues, pull requests, labels, comments
// ---------------------------------------------------------------------------

export function createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const number = repo.nextNumber++;
  const id = nextGlobalId++;
  const issue: Issue = {
    id,
    nodeId: globalId('Issue', `${repo.id}:${number}`),
    number,
    title,
    body,
    state: 'open',
    labels: [...labels],
    userLogin: VIEWER.login,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    jsonCache: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull {
  const number = repo.nextNumber++;
  const id = nextGlobalId++;
  const pull: Pull = {
    id,
    nodeId: globalId('PullRequest', `${repo.id}:${number}`),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    userLogin: VIEWER.login,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    jsonCache: null,
  };
  repo.pulls.set(number, pull);
  return pull;
}

export function addComment(repo: Repo, number: number, body: string): Comment {
  const id = nextGlobalId++;
  const comment: Comment = {
    id,
    nodeId: globalId('IssueComment', `${repo.id}:${id}`),
    body,
    userLogin: VIEWER.login,
    createdAt: FIXED_ISO,
  };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return comment;
}

/** The branch a ref name addresses, without the refs/heads/ prefix. */
export function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export { ZERO_OID };
