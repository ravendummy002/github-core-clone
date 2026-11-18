// GraphQL at POST /api/graphql: a small parser for operations, aliases, arguments,
// variables, input objects and inline fragments, a validator that names unknown
// fields, and an executor over the same in-memory store the REST surface uses.
// Bodies may hold one operation document or an array of them (batching, answered
// in order). Unauthenticated requests are exactly 401; a bad field is HTTP 200
// with an errors array naming it; an unknown repository is data.repository null.

import {
  jsonError,
  jsonResponse,
  isAuthorized,
  parseJsonBody,
  type HttpResponse,
  type RequestContext,
} from './http.ts';
import {
  addComment,
  commitTree,
  createIssue,
  createPull,
  decodeGlobalId,
  diffTrees,
  getRepo,
  listRepos,
  planMerge,
  resolveRef,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { mergePullRequest } from './rest.ts';
import { VIEWER, VIEWER_LOGIN } from './scenario.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('{}():=@!$[]|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      index += 1;
      while (index < source.length) {
        const c = source[index] as string;
        if (c === '"') {
          index += 1;
          break;
        }
        if (c === '\\' && index + 1 < source.length) {
          const escape = source[index + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          value += map[escape] ?? escape;
          index += 2;
          continue;
        }
        value += c;
        index += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let value = '';
      while (index < source.length && /[0-9eE.+-]/.test(source[index] as string)) {
        value += source[index] as string;
        index += 1;
      }
      tokens.push({ kind: value.includes('.') || /e/i.test(value) ? 'float' : 'int', value });
      continue;
    }
    if (isNameStart(ch)) {
      let value = '';
      while (index < source.length && isNameChar(source[index] as string)) {
        value += source[index] as string;
        index += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.position] as Token;
    this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error('expected an operation or fragment definition');
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return variables;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      variables.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.matchPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(allowConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (allowConst) throw new Error('variables are not allowed in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue(allowConst));
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue(allowConst);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('expected a value in GraphQL document');
  }
}

// ---------------------------------------------------------------------------
// schema: the field tables double as the validator and the introspection data
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'repository', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/** A resolved value, tagged with its GraphQL type so sub-selections can resolve against it. */
interface TypedValue {
  type: string;
  value: unknown;
}

interface IssueRef {
  repo: Repo;
  issue: Issue;
}

interface PullRef {
  repo: Repo;
  pull: Pull;
}

interface CommentRef {
  repo: Repo;
  comment: { id: number; nodeId: string; body: string; userLogin: string; createdAt: string };
}

interface ConnectionValue {
  nodes: TypedValue[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
}

class GraphQLError extends Error {}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(args)) out[key] = evalValue(node, variables);
  return out;
}

function asStringArg(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asIntArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function asStringListArg(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

function cursorFor(kind: string, number: number): string {
  return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null, kind: string): number | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const [prefix, raw] = text.split(':');
    if (prefix !== kind) return null;
    const parsed = Number.parseInt(raw as string, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function viewerUser(): TypedValue {
  return { type: 'User', value: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } };
}

function repoByDatabaseId(id: number): Repo | null {
  return listRepos().find((repo) => repo.id === id) ?? null;
}

function issueConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  const states = asStringListArg(args['states']);
  const orderBy = (args['orderBy'] as Record<string, unknown> | undefined) ?? {};
  const direction = (orderBy['direction'] as string | undefined) ?? 'DESC';
  const after = cursorNumber(asStringArg(args['after']), 'issue');
  const first = asIntArg(args['first']);
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states);
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    issues = index < 0 ? issues : issues.slice(index + 1);
  }
  const totalCount = issues.length;
  const page = first === null ? issues : issues.slice(0, first);
  const hasNextPage = first !== null && issues.length > first;
  const last = page[page.length - 1];
  const value: ConnectionValue = {
    nodes: page.map((issue) => ({ type: 'Issue', value: { repo, issue } as IssueRef })),
    pageInfo: { hasNextPage, endCursor: last === undefined ? null : cursorFor('issue', last.number) },
    totalCount,
  };
  return { type: 'IssueConnection', value };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  const states = asStringListArg(args['states']) ?? ['OPEN'];
  const orderBy = (args['orderBy'] as Record<string, unknown> | undefined) ?? {};
  const direction = (orderBy['direction'] as string | undefined) ?? 'DESC';
  const after = cursorNumber(asStringArg(args['after']), 'pull');
  const first = asIntArg(args['first']);
  const wanted = new Set(states);
  let pulls = [...repo.pulls.values()].filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    return wanted.has(state);
  });
  pulls.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  if (after !== null) {
    const index = pulls.findIndex((pull) => pull.number === after);
    pulls = index < 0 ? pulls : pulls.slice(index + 1);
  }
  const totalCount = pulls.length;
  const page = first === null ? pulls : pulls.slice(0, first);
  const hasNextPage = first !== null && pulls.length > first;
  const last = page[page.length - 1];
  const value: ConnectionValue = {
    nodes: page.map((pull) => ({ type: 'PullRequest', value: { repo, pull } as PullRef })),
    pageInfo: { hasNextPage, endCursor: last === undefined ? null : cursorFor('pull', last.number) },
    totalCount,
  };
  return { type: 'PullRequestConnection', value };
}

function pullFilesConnection(ref: PullRef, args: Record<string, unknown>): TypedValue {
  const { repo, pull } = ref;
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  const files =
    headTip === null || baseTip === null
      ? []
      : diffTrees(repo, commitTree(repo, baseTip), commitTree(repo, headTip));
  const first = asIntArg(args['first']);
  const page = first === null ? files : files.slice(0, first);
  const value: ConnectionValue = {
    nodes: page.map((file) => ({
      type: 'PullRequestChangedFile',
      value: {
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      },
    })),
    pageInfo: { hasNextPage: first !== null && files.length > first, endCursor: null },
    totalCount: files.length,
  };
  return { type: 'PullRequestChangedFileConnection', value };
}

function mergeableState(ref: PullRef): string {
  const { repo, pull } = ref;
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  return planMerge(repo, baseTip, headTip).conflicted ? 'CONFLICTING' : 'MERGEABLE';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function typeInfo(name: string): TypedValue | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    type: '__Type',
    value: {
      name,
      kind: fields !== undefined ? 'OBJECT' : 'ENUM',
      fields: fields === undefined ? null : fields.map((field) => ({ name: field })),
      enumValues: enumValues === undefined ? null : enumValues.map((entry) => ({ name: entry })),
    },
  };
}

function decodeRepoId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const dbid = Number.parseInt(decoded.key, 10);
  if (!Number.isFinite(dbid)) return null;
  return repoByDatabaseId(dbid);
}

function decodeIssueId(id: string): IssueRef | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = repoByDatabaseId(Number.parseInt(repoId as string, 10));
  if (repo === null) return null;
  const issue = repo.issues.get(Number.parseInt(number as string, 10));
  return issue === undefined ? null : { repo, issue };
}

function decodePullId(id: string): PullRef | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = repoByDatabaseId(Number.parseInt(repoId as string, 10));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number.parseInt(number as string, 10));
  return pull === undefined ? null : { repo, pull };
}

function nodeById(id: string): TypedValue | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = decodeRepoId(id);
    return repo === null ? null : { type: 'Repository', value: repo };
  }
  if (decoded.kind === 'Issue') {
    const ref = decodeIssueId(id);
    return ref === null ? null : { type: 'Issue', value: ref };
  }
  if (decoded.kind === 'PullRequest') {
    const ref = decodePullId(id);
    return ref === null ? null : { type: 'PullRequest', value: ref };
  }
  return null;
}

/**
 * Resolve one field on a typed value. Returns a scalar, null, a TypedValue, or an
 * array of TypedValues (for connection `nodes` lists). Throws GraphQLError when
 * the field cannot be resolved (a mutation on a missing object, a conflicted merge).
 */
function resolveField(parent: TypedValue, name: string, args: Record<string, unknown>): unknown {
  const value = parent.value as Record<string, unknown>;
  switch (parent.type) {
    case 'Query': {
      if (name === 'viewer') return viewerUser();
      if (name === 'repository') {
        const owner = asStringArg(args['owner']);
        const repoName = asStringArg(args['name']);
        if (owner === null || repoName === null) throw new GraphQLError('repository requires owner and name');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = getRepo(repoName);
        return repo === undefined ? null : { type: 'Repository', value: repo };
      }
      if (name === 'node') {
        const id = asStringArg(args['id']);
        if (id === null) throw new GraphQLError('node requires id');
        return nodeById(id);
      }
      if (name === '__type') {
        const typeName = asStringArg(args['name']);
        return typeName === null ? null : typeInfo(typeName);
      }
      break;
    }
    case 'Mutation': {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      if (name === 'createIssue') {
        const repo = decodeRepoId(asStringArg(input['repositoryId']) ?? '');
        if (repo === null) throw new GraphQLError('repository not found');
        const title = asStringArg(input['title']);
        if (title === null) throw new GraphQLError('title is required');
        const issue = createIssue(repo, title, asStringArg(input['body']) ?? '', []);
        return { type: 'CreateIssuePayload', value: { issue: { repo, issue } as IssueRef } };
      }
      if (name === 'closeIssue') {
        const ref = decodeIssueId(asStringArg(input['issueId']) ?? '');
        if (ref === null) throw new GraphQLError('issue not found');
        ref.issue.state = 'closed';
        ref.issue.jsonCache = null;
        return { type: 'CloseIssuePayload', value: { issue: ref } };
      }
      if (name === 'createPullRequest') {
        const repo = decodeRepoId(asStringArg(input['repositoryId']) ?? '');
        if (repo === null) throw new GraphQLError('repository not found');
        const headRef = asStringArg(input['headRefName']);
        const baseRef = asStringArg(input['baseRefName']);
        const title = asStringArg(input['title']);
        if (headRef === null || baseRef === null || title === null) throw new GraphQLError('headRefName, baseRefName and title are required');
        if (repo.refs.get(`refs/heads/${headRef}`) === undefined) throw new GraphQLError('head branch does not exist');
        if (repo.refs.get(`refs/heads/${baseRef}`) === undefined) throw new GraphQLError('base branch does not exist');
        const pull = createPull(repo, title, asStringArg(input['body']) ?? '', headRef, baseRef);
        return { type: 'CreatePullRequestPayload', value: { pullRequest: { repo, pull } as PullRef } };
      }
      if (name === 'mergePullRequest') {
        const ref = decodePullId(asStringArg(input['pullRequestId']) ?? '');
        if (ref === null) throw new GraphQLError('pull request not found');
        const result = mergePullRequest(ref.repo, ref.pull);
        if ('status' in result) throw new GraphQLError('pull request cannot be merged');
        return { type: 'MergePullRequestPayload', value: { pullRequest: ref } };
      }
      if (name === 'addComment') {
        const subjectId = asStringArg(input['subjectId']) ?? '';
        const bodyText = asStringArg(input['body']);
        if (bodyText === null) throw new GraphQLError('body is required');
        const issueRef = decodeIssueId(subjectId);
        const pullRef = issueRef === null ? decodePullId(subjectId) : null;
        const ref = issueRef ?? pullRef;
        if (ref === null) throw new GraphQLError('subject not found');
        const number = issueRef !== null ? issueRef.issue.number : (pullRef as PullRef).pull.number;
        const comment = addComment(ref.repo, number, bodyText);
        const issue = ref.repo.issues.get(number);
        if (issue !== undefined) issue.jsonCache = null;
        return {
          type: 'AddCommentPayload',
          value: {
            commentEdge: {
              type: 'IssueCommentEdge',
              value: {
                node: { type: 'IssueComment', value: { repo: ref.repo, comment } as CommentRef },
                cursor: null,
              },
            },
          },
        };
      }
      break;
    }
    case 'User': {
      if (name === 'login' || name === 'name' || name === 'email') return value[name] ?? null;
      if (name === 'id') return String(value['id'] ?? '');
      if (name === 'avatarUrl') return '';
      break;
    }
    case 'Repository': {
      const repo = parent.value as Repo;
      if (name === 'id') return repo.nodeId;
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return viewerUser();
      if (name === 'defaultBranchRef') return { type: 'Ref', value: { name: repo.defaultBranch } };
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const number = asIntArg(args['number']);
        if (number === null) return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : { type: 'Issue', value: { repo, issue } as IssueRef };
      }
      if (name === 'issues') return issueConnection(repo, args);
      if (name === 'pullRequests') return pullConnection(repo, args);
      if (name === 'pullRequest') {
        const number = asIntArg(args['number']);
        if (number === null) return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : { type: 'PullRequest', value: { repo, pull } as PullRef };
      }
      break;
    }
    case 'Issue': {
      const ref = parent.value as IssueRef;
      const issue = ref.issue;
      if (name === 'id') return issue.nodeId;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'author') return { type: 'User', value: { login: issue.userLogin, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } };
      if (name === 'labels') {
        return {
          type: 'LabelConnection',
          value: {
            nodes: issue.labels.map((label) => ({ type: 'Label', value: label })),
            totalCount: issue.labels.length,
          },
        };
      }
      if (name === 'comments') {
        const comments = ref.repo.comments.get(issue.number) ?? [];
        return {
          type: 'IssueCommentConnection',
          value: {
            nodes: comments.map((comment) => ({ type: 'IssueComment', value: { repo: ref.repo, comment } as CommentRef })),
            pageInfo: { hasNextPage: false, endCursor: null },
            totalCount: comments.length,
          },
        };
      }
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'repository') return { type: 'Repository', value: ref.repo };
      if (name === 'url') return '';
      break;
    }
    case 'PullRequest': {
      const ref = parent.value as PullRef;
      const pull = ref.pull;
      if (name === 'id') return pull.nodeId;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullState(pull);
      if (name === 'merged') return pull.merged;
      if (name === 'mergeable') return mergeableState(ref);
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'files') return pullFilesConnection(ref, args);
      if (name === 'author') return { type: 'User', value: { login: pull.userLogin, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } };
      if (name === 'createdAt') return pull.createdAt;
      if (name === 'updatedAt') return pull.updatedAt;
      break;
    }
    case 'Ref': {
      if (name === 'name') return value['name'] ?? null;
      if (name === 'target') return null;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      const connection = parent.value as unknown as { nodes: TypedValue[]; pageInfo?: unknown; totalCount?: number };
      if (name === 'nodes') return connection.nodes;
      if (name === 'pageInfo') return connection.pageInfo === undefined ? null : { type: 'PageInfo', value: connection.pageInfo };
      if (name === 'totalCount') return connection.totalCount ?? connection.nodes.length;
      if (name === 'edges') return [];
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return value['hasNextPage'] ?? false;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      if (name === 'endCursor') return value['endCursor'] ?? null;
      break;
    }
    case 'Label': {
      if (name === 'name' || name === 'color' || name === 'description') return value[name] ?? null;
      if (name === 'id') return '';
      break;
    }
    case 'IssueComment': {
      const ref = parent.value as CommentRef;
      if (name === 'id') return ref.comment.nodeId;
      if (name === 'body') return ref.comment.body;
      if (name === 'author') return { type: 'User', value: { login: ref.comment.userLogin, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } };
      if (name === 'createdAt') return ref.comment.createdAt;
      break;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return value['node'] as TypedValue;
      if (name === 'cursor') return null;
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path' || name === 'changeType') return value[name] ?? null;
      if (name === 'additions' || name === 'deletions') return value[name] ?? 0;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return { type: 'Issue', value: value['issue'] as IssueRef };
      if (name === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return { type: 'PullRequest', value: value['pullRequest'] as PullRef };
      if (name === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return value['commentEdge'] as TypedValue;
      if (name === 'clientMutationId') return null;
      break;
    }
    case '__Type': {
      if (name === 'name') return value['name'] ?? null;
      if (name === 'kind') return value['kind'] ?? null;
      if (name === 'description') return null;
      if (name === 'fields') {
        const fields = value['fields'] as Array<{ name: string }> | null;
        return fields === null ? null : fields.map((field) => ({ type: '__Field', value: field }));
      }
      if (name === 'enumValues') {
        const entries = value['enumValues'] as Array<{ name: string }> | null;
        return entries === null ? null : entries.map((entry) => ({ type: '__EnumValue', value: entry }));
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return value['name'] ?? null;
      if (name === 'description') return null;
      if (name === 'type') return null;
      break;
    }
  }
  throw new GraphQLError(`Cannot query field "${name}" on type "${parent.type}".`);
}

function isTypedValue(candidate: unknown): candidate is TypedValue {
  if (candidate === null || typeof candidate !== 'object') return false;
  const record = candidate as Record<string, unknown>;
  return typeof record['type'] === 'string' && 'value' in record;
}

interface ExecutorContext {
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function expandSelections(
  selections: SelectionNode[],
  typeName: string,
  ctx: ExecutorContext,
): Array<{ kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: SelectionNode[] }> {
  const out: Array<{ kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: SelectionNode[] }> = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        out.push(...expandSelections(selection.selections, typeName, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        out.push(...expandSelections(fragment.selections, typeName, ctx));
      }
    }
  }
  return out;
}

/** Validate a selection set against the field tables; returns the first unknown field, if any. */
function validateSelections(
  selections: SelectionNode[],
  typeName: string,
  fragments: Map<string, FragmentNode>,
  path: string[],
): string | null {
  const fields = TYPE_FIELDS[typeName];
  if (fields === undefined) return null;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (!fields.includes(selection.name)) {
        return `Cannot query field "${selection.name}" on type "${typeName}".`;
      }
      // Recurse into sub-selections with the child's type, when it is known.
      const childType = childTypeOf(typeName, selection.name);
      if (childType !== null && selection.selections.length > 0) {
        const problem = validateSelections(selection.selections, childType, fragments, [...path, selection.name]);
        if (problem !== null) return problem;
      }
    } else if (selection.kind === 'inline') {
      const target = selection.typeCondition ?? typeName;
      if (TYPE_FIELDS[target] === undefined) return `Unknown type "${target}".`;
      const problem = validateSelections(selection.selections, target, fragments, path);
      if (problem !== null) return problem;
    } else {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) return `Unknown fragment "${selection.name}".`;
      const problem = validateSelections(fragment.selections, fragment.typeCondition, fragments, path);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/** The GraphQL type a field's sub-selections resolve against, for validation. */
function childTypeOf(parentType: string, field: string): string | null {
  const table: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository', __type: '__Type' },
    Mutation: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User',
      defaultBranchRef: 'Ref',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest',
    },
    Issue: { author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository' },
    PullRequest: { author: 'User', files: 'PullRequestChangedFileConnection' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    IssueCommentConnection: { nodes: 'IssueComment', pageInfo: 'PageInfo' },
    LabelConnection: { nodes: 'Label' },
    IssueCommentEdge: { node: 'IssueComment' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return table[parentType]?.[field] ?? null;
}

function executeSelections(
  parent: TypedValue,
  selections: SelectionNode[],
  ctx: ExecutorContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of expandSelections(selections, parent.type, ctx)) {
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    if (field.name === '__typename') {
      result[key] = parent.type;
      continue;
    }
    let resolved: unknown;
    try {
      resolved = resolveField(parent, field.name, evalArgs(field.args, ctx.variables));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'field resolution failed', path: fieldPath });
      result[key] = null;
      continue;
    }
    result[key] = completeValue(resolved, field.selections, ctx, fieldPath);
  }
  return result;
}

function completeValue(
  resolved: unknown,
  selections: SelectionNode[],
  ctx: ExecutorContext,
  path: Array<string | number>,
): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((item, index) => completeValue(item, selections, ctx, [...path, index]));
  }
  if (isTypedValue(resolved)) {
    if (selections.length === 0) return null;
    return executeSelections(resolved, selections, ctx, path);
  }
  return resolved;
}

function executeOperation(
  operation: OperationNode,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): { data: unknown; errors?: Array<{ message: string; path: Array<string | number> }> } {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const validation = validateSelections(operation.selections, rootType, fragments, []);
  if (validation !== null) {
    return { data: null, errors: [{ message: validation, path: [] }] };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue !== null) {
      mergedVariables[variable.name] = evalValue(variable.defaultValue, variables);
    }
  }
  const ctx: ExecutorContext = { fragments, variables: mergedVariables, errors: [] };
  const root: TypedValue = { type: rootType, value: null };
  const data = executeSelections(root, operation.selections, ctx, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function executeDocument(
  document: { query?: unknown; variables?: unknown; operationName?: unknown },
): { data: unknown; errors?: Array<{ message: string; path: Array<string | number> }> } {
  if (typeof document.query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string', path: [] }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(document.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error', path: [] }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  const operationName = typeof document.operationName === 'string' ? document.operationName : null;
  const operation =
    operationName === null
      ? operations[0]
      : operations.find((candidate) => candidate.name === operationName);
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'operation not found', path: [] }] };
  }
  const variables =
    document.variables !== null && typeof document.variables === 'object' && !Array.isArray(document.variables)
      ? (document.variables as Record<string, unknown>)
      : {};
  return executeOperation(operation, fragments, variables);
}

export function handleGraphQL(ctx: RequestContext): HttpResponse {
  if (!isAuthorized(ctx)) return jsonError(401, 'Unauthorized');
  if (ctx.method !== 'POST') return jsonError(404, 'Not Found');
  const body = parseJsonBody(ctx);
  if (body === null) {
    return jsonResponse(400, { errors: [{ message: 'request body must be valid JSON' }] });
  }
  if (Array.isArray(body)) {
    return jsonResponse(200, body.map((entry) => executeDocument((entry ?? {}) as { query?: unknown })));
  }
  if (typeof body !== 'object') {
    return jsonResponse(400, { errors: [{ message: 'request body must be an object' }] });
  }
  return jsonResponse(200, executeDocument(body as { query?: unknown }));
}
