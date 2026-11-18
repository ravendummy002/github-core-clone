// Git smart HTTP: info/refs advertisements (upload-pack v2 and v0, receive-pack v0),
// the v2 ls-refs and fetch commands, the v0 fetch, and the v0 receive-pack push.
// The object model and framing live in gitobj.ts; the store in store.ts.
//
// The protocol shapes this implements, as the suite drives them:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (Git-Protocol: version=2 -> v2)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0 only)
//   POST /{owner}/{repo}.git/git-upload-pack                     (v2 commands, or v0 want/have)
//   POST /{owner}/{repo}.git/git-receive-pack                    (v0 command list + pack)

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  pktLine,
  pktLines,
  readPack,
  sidebandPack,
  writePack,
  type GitObject,
  type Packet,
} from './gitobj.ts';
import {
  collectReachable,
  getRepo,
  isAncestor,
  peelTag,
  type Repo,
} from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

const AGENT = 'makefun-forge/1.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n', 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`${message}\n`, 'utf8') };
}

/** The repository a git path names, or null when the owner or the repo is unknown. */
function repoFor(owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(repoName) ?? null;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

/** The v2 capability advertisement: `version 2` plus capability lines, then a flush. */
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** A v0 ref advertisement: the service preamble, then `<oid> <ref>` lines, then a flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${headTarget(repo)} side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo));
    let first = true;
    const headLine = headOid !== undefined ? `${headOid} HEAD` : null;
    const lines: string[] = [];
    if (headLine !== null) lines.push(headLine);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}`);
      // An annotated tag's peeled commit follows its own line as `<ref>^{}`.
      const object = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && object?.type === 'tag') {
        const peeled = peelTag(repo, oid);
        if (peeled !== null) lines.push(`${peeled} ${name}^{}`);
      }
    }
    for (const line of lines) {
      if (first) {
        parts.push(pktLine(`${line}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${line}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocol: string | null,
): GitResponse {
  const repo = repoFor(owner, repoName);
  if (repo === null) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
    }
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
  }
  return badRequest('unknown service');
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD symref-target:${headTarget(repo)}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:${headTarget(repo)}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    const object = repo.objects.get(oid);
    if (args.peel && name.startsWith('refs/tags/') && object?.type === 'tag') {
      const peeled = peelTag(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** When set, `depth` counts generations past the client's current shallow boundary. */
  deepenRelative: boolean;
}

export interface FetchPlan {
  /** The objects the pack carries, in a deterministic order. */
  objects: GitObject[];
  /** The new shallow boundary: included commits whose parents were cut off. */
  shallow: string[];
  /** Formerly shallow commits that are now fully held. */
  unshallow: string[];
}

/**
 * Work out what a fetch sends. `wants` are peeled to commits (tag objects ride along);
 * the walk from the wants stops at `depth` generations when one is given; everything
 * reachable from `haves` is withheld — except that a have on the client's shallow
 * boundary contributes only itself and its tree, never its parents, because the
 * client does not hold them.
 */
export function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const shallowSet = new Set(args.shallow);
  const tagObjects: GitObject[] = [];
  const wantCommits: string[] = [];
  const directObjects: GitObject[] = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjects.push(object);
      const peeled = peelTag(repo, want);
      if (peeled !== null) wantCommits.push(peeled);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      directObjects.push(object);
    }
  }

  // A relative deepen counts from the client's current boundary: one more than
  // the deepest shallow commit's distance from a want. (The suite's client
  // always sends an absolute depth; real git sends deepen-relative for --deepen.)
  let depth = args.depth;
  if (depth !== null && args.deepenRelative) {
    const shallowSetForDepth = new Set(args.shallow);
    let deepest = -1;
    const distanceQueue: Array<{ oid: string; distance: number }> = wantCommits.map((oid) => ({ oid, distance: 0 }));
    const distanceSeen = new Set<string>();
    while (distanceQueue.length > 0) {
      const { oid, distance } = distanceQueue.shift() as { oid: string; distance: number };
      if (distanceSeen.has(oid)) continue;
      distanceSeen.add(oid);
      if (shallowSetForDepth.has(oid)) deepest = Math.max(deepest, distance);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      try {
        for (const parent of parseCommit(object.data).parents) {
          if (!distanceSeen.has(parent)) distanceQueue.push({ oid: parent, distance: distance + 1 });
        }
      } catch {
        // ignore
      }
    }
    depth = deepest + 1 + depth;
  }

  // The included commits: a breadth-first walk from the wants, by generation.
  const included = new Map<string, number>(); // oid -> distance from a want
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = wantCommits.map((oid) => ({ oid, distance: 0 }));
  while (queue.length > 0) {
    const { oid, distance } = queue.shift() as { oid: string; distance: number };
    if (included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.set(oid, distance);
    let parents: string[];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      continue;
    }
    if (depth !== null && distance + 1 >= depth) {
      if (parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of parents) {
      if (!included.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
    }
  }

  // The objects the fetch carries: each included commit, its tree closure (trees
  // and blobs — never its parents, which the depth limit cut off), the wanted
  // tags, and any directly wanted objects.
  const wanted = new Set<string>();
  for (const tag of tagObjects) wanted.add(hashObject(tag.type, tag.data));
  for (const object of directObjects) wanted.add(hashObject(object.type, object.data));
  for (const oid of included.keys()) {
    wanted.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    try {
      const tree = parseCommit(object.data).tree;
      for (const reached of collectReachable(repo, [tree])) wanted.add(reached);
    } catch {
      // a malformed commit contributes nothing further
    }
  }

  // Everything the client already holds: the haves' closure, cut at the shallow boundary.
  // A have on the boundary contributes itself and its tree, never its parents — the
  // client does not hold them (that is what "shallow" means), so a deepen must still
  // deliver those ancestors.
  const held = new Set<string>();
  const heldQueue: string[] = [...args.haves];
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop() as string;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      try {
        const commit = parseCommit(object.data);
        for (const reached of collectReachable(repo, [commit.tree])) held.add(reached);
      } catch {
        // ignore
      }
      if (shallowSet.has(oid)) continue;
      try {
        for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
      } catch {
        // ignore
      }
    } else if (object.type === 'tag') {
      try {
        heldQueue.push(parseTag(object.data).object);
      } catch {
        // ignore
      }
    } else if (object.type === 'tree') {
      for (const reached of collectReachable(repo, [oid])) held.add(reached);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Deterministic pack order: commits, then trees, then tags, then blobs; by oid within a type.
  const typeOrder: Record<string, number> = { commit: 0, tree: 1, tag: 2, blob: 3 };
  objects.sort((a, b) => {
    const byType = (typeOrder[a.type] as number) - (typeOrder[b.type] as number);
    if (byType !== 0) return byType;
    return hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1;
  });

  // The new boundary, and the old boundary commits that are now deepened.
  const shallow = [...boundary].sort();
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    if (!included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    let parents: string[];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      continue;
    }
    if (parents.every((parent) => included.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();
  return { objects, shallow, unshallow };
}

function fetchCacheKey(repo: Repo, args: FetchArgs): string {
  return [
    repo.version,
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.depth === null ? '' : String(args.depth),
    args.deepenRelative ? 'rel' : 'abs',
  ].join('|');
}

function cachedFetch(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = fetchCacheKey(repo, args);
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const plan = computeFetch(repo, args);
  const result = { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow };
  if (repo.packCache.size >= 64) {
    const oldest = repo.packCache.keys().next().value as string | undefined;
    if (oldest !== undefined) repo.packCache.delete(oldest);
  }
  repo.packCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = cachedFetch(repo, args);
  const parts: Buffer[] = [];
  // Sections are separated by DELIM (0001) packets; only the last section ends
  // with a FLUSH (0000). A flush between sections makes real git stop reading
  // the response where the next section should begin.
  // The acknowledgments section exists only when the client sent haves: a fetch
  // with nothing to negotiate (a fresh clone) must not carry one — real git
  // treats its presence there as a protocol error.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    for (const have of args.haves) {
      if (repo.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = cachedFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (args.haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of args.haves) {
      if (repo.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack POST
// ---------------------------------------------------------------------------

function parseV2Args(packets: readonly Packet[]): { command: string; args: string[] } {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  const command = first.startsWith('command=') ? first.slice('command='.length) : '';
  return { command, args: lines.slice(1).map((line) => line.replace(/\n$/, '')) };
}

export function handleUploadPack(
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): GitResponse {
  const repo = repoFor(owner, repoName);
  if (repo === null) return notFound();
  let packets: Packet[];
  try {
    packets = decodePktLines(body, { stopAtRaw: false }).packets;
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  if (gitProtocol === 'version=2') {
    const { command, args } = parseV2Args(packets);
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of args) {
        if (arg === 'peel') lsArgs.peel = true;
        else if (arg === 'symrefs') lsArgs.symrefs = true;
        else if (arg === 'unborn') lsArgs.unborn = true;
        else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return ok('application/x-git-upload-pack-result', handleLsRefs(repo, lsArgs));
    }
    if (command === 'fetch') {
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim());
        else if (arg === 'deepen-relative') fetchArgs.deepenRelative = true;
        else if (arg.startsWith('deepen ')) {
          const depth = Number.parseInt(arg.slice(7).trim(), 10);
          if (Number.isFinite(depth) && depth > 0) fetchArgs.depth = depth;
        }
      }
      return ok('application/x-git-upload-pack-result', handleFetchV2(repo, fetchArgs));
    }
    return ok('application/x-git-upload-pack-result', pktLines([`ERR unknown command ${command}\n`, 'flush']));
  }
  // Protocol v0: a wants section, a flush, then a haves section and a flush.
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const oid = rest.split(' ')[0] as string;
        if (isObjectId(oid)) fetchArgs.wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        fetchArgs.shallow.push(line.slice(8).trim());
      } else if (line === 'deepen-relative') {
        fetchArgs.deepenRelative = true;
      } else if (line.startsWith('deepen ')) {
        const depth = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) fetchArgs.depth = depth;
      }
    } else if (line.startsWith('have ')) {
      fetchArgs.haves.push(line.slice(5).trim());
    }
  }
  return ok('application/x-git-upload-pack-result', handleFetchV0(repo, fetchArgs));
}

// ---------------------------------------------------------------------------
// receive-pack POST
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = repoFor(owner, repoName);
  if (repo === null) return notFound();
  const contentType = 'application/x-git-receive-pack-result';

  const report = (lines: string[]): Buffer => {
    // The report-status stream is itself pkt-lined, carried inside sideband band 1.
    const inner = pktLines([...lines.map((line) => `${line}\n`), 'flush']);
    const outer: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH];
    return Buffer.concat(outer);
  };

  let packets: Packet[];
  let packBytes: Buffer;
  try {
    const decoded = decodePktLines(body, { stopAtRaw: true });
    packets = decoded.packets;
    packBytes = decoded.rest;
  } catch {
    return ok(contentType, report(['unpack error: malformed command list']));
  }

  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string)) {
      return ok(contentType, report(['unpack error: malformed command']));
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  void sideband; // the client always negotiates side-band-64k; the report is framed that way regardless.

  // Unpack first, into a scratch map: a bad pack refuses the whole push and stores nothing.
  const unpacked = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, {
        resolveBase: (oid) => repo.objects.get(oid),
        checkTrailer: true,
      });
      for (const [oid, object] of objects) unpacked.set(oid, object);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'pack error';
      return ok(contentType, report([`unpack error: ${detail}`]));
    }
  }
  for (const [oid, object] of unpacked) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }
  if (unpacked.size > 0) {
    repo.version += 1;
    repo.packCache.clear();
  }

  const lines: string[] = ['unpack ok'];
  let refsChanged = false;
  for (const command of commands) {
    if (!command.ref.startsWith('refs/') || command.ref.includes(' ') || command.ref.includes('\0')) {
      lines.push(`ng ${command.ref} invalid ref`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push(`ng ${command.ref} old oid mismatch`);
      } else {
        repo.refs.delete(command.ref);
        refsChanged = true;
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      lines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        lines.push(`ng ${command.ref} already exists`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        refsChanged = true;
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined) {
      lines.push(`ng ${command.ref} remote ref does not exist`);
      continue;
    }
    if (command.oldOid !== current) {
      lines.push(`ng ${command.ref} old oid mismatch`);
      continue;
    }
    const newObject = repo.objects.get(command.newOid) as GitObject;
    const oldObject = repo.objects.get(command.oldOid);
    if (newObject.type === 'tag' || oldObject?.type === 'tag') {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (!isAncestor(repo, command.oldOid, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refsChanged = true;
    lines.push(`ok ${command.ref}`);
  }
  if (refsChanged) {
    repo.version += 1;
    repo.packCache.clear();
  }
  return ok(contentType, report(lines));
}
