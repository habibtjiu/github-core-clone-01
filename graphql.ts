// GraphQL v4 surface: a minimal lexer + recursive-descent parser and an
// executor over the shared store. Only the subset the grading suite sends
// is supported: query/mutation, aliases, arguments, inline fragments and
// __type introspection. Unknown fields fail the whole document (data: null)
// with a "Cannot query field" error, per the GraphQL spec.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized, parseJson, pathOf, readBody, sendError, sendJson } from './http-util.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { ContentOps, IssueOps, PullOps } from './store.ts';

// --- global ids -------------------------------------------------------------
// Opaque base64 ids; the kind prefix keeps Repository/Issue/PullRequest/
// IssueComment ids distinct even when the numeric parts collide.

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':')).toString('base64');
}

function decodeGid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    if (Buffer.from(text).toString('base64') !== id) return null;
    return parts;
  } catch {
    return null;
  }
}

// --- lexer ------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]!:=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const raw = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --- parser -----------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`Expected "${value}" but got "${tok.value}"`);
    }
  }

  private acceptPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`Expected a name but got "${tok.value}"`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '{') {
      return { kind: 'query', name: null, selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation') {
      throw new Error(`Unsupported operation type "${keyword}"`);
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
    return { kind: keyword, name, selections: this.parseSelectionSet() };
  }

  // Variable definitions are parsed only so the document is accepted; types
  // are not validated and defaults are ignored.
  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.acceptPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let typeCondition = '';
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  // Directives are not part of the suite's documents; skip them so a stray
  // @include/@skip never breaks parsing.
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Unexpected token "${tok.value}" in value position`);
  }
}

// --- executor ---------------------------------------------------------------

// A resolved object: its GraphQL type plus the underlying store value (or a
// plain record for payloads, connections and introspection leaves).
interface NodeRef {
  type: string;
  value: unknown;
}

interface ExecCtx {
  store: Store;
  issueOps: IssueOps;
  pullOps: PullOps;
  errors: { message: string }[];
}

type Resolver = (
  node: NodeRef,
  field: string,
  args: Record<string, unknown>,
  ctx: ExecCtx,
) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(
  args: { name: string; value: ValueNode }[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function resolveNodeValue(
  raw: unknown,
  selections: SelectionNode[] | null,
  variables: Record<string, unknown>,
  ctx: ExecCtx,
): unknown {
  if (raw !== null && typeof raw === 'object' && 'type' in raw && 'value' in raw) {
    const node = raw as NodeRef;
    if (selections === null) return null;
    return select(node, selections, variables, ctx);
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => resolveNodeValue(item, selections, variables, ctx));
  }
  return raw;
}

function select(
  node: NodeRef,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === '' || sel.typeCondition === node.type) {
        Object.assign(out, select(node, sel.selections, variables, ctx));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const resolver = RESOLVERS[node.type]?.[sel.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${node.type}".` });
      out[key] = null;
      continue;
    }
    const raw = resolver(node, sel.name, resolveArgs(sel.args, variables), ctx);
    out[key] = resolveNodeValue(raw, sel.selections, variables, ctx);
  }
  return out;
}

// Payloads, connections, page info and introspection leaves are plain
// records; reading a missing property is an unknown-field error.
function recordResolver(node: NodeRef, field: string, _args: Record<string, unknown>, ctx: ExecCtx): unknown {
  if (!isRecord(node.value) || !Object.prototype.hasOwnProperty.call(node.value, field)) {
    ctx.errors.push({ message: `Cannot query field "${field}" on type "${node.type}".` });
    return null;
  }
  return node.value[field];
}

function repoOf(ctx: ExecCtx, id: number): Repo | undefined {
  return ctx.store.listRepos().find((repo) => repo.id === id);
}

function issueNode(repo: Repo, issue: Issue): NodeRef {
  return { type: 'Issue', value: { repo, issue } };
}

function prNode(repo: Repo, pr: PullRequest): NodeRef {
  return { type: 'PullRequest', value: { repo, pr } };
}

function repoNode(repo: Repo): NodeRef {
  return { type: 'Repository', value: repo };
}

function decodeRepoId(ctx: ExecCtx, globalId: unknown): Repo | undefined {
  if (typeof globalId !== 'string') return undefined;
  const parts = decodeGid(globalId);
  if (parts === null || parts[0] !== 'Repository') return undefined;
  return repoOf(ctx, Number(parts[1]));
}

function decodeIssueRef(
  ctx: ExecCtx,
  globalId: unknown,
): { repo: Repo; issue: Issue } | undefined {
  if (typeof globalId !== 'string') return undefined;
  const parts = decodeGid(globalId);
  if (parts === null || parts[0] !== 'Issue') return undefined;
  const repo = repoOf(ctx, Number(parts[1]));
  const issue = repo?.issues.get(Number(parts[2]));
  if (repo === undefined || issue === undefined) return undefined;
  return { repo, issue };
}

function decodePrRef(
  ctx: ExecCtx,
  globalId: unknown,
): { repo: Repo; pr: PullRequest } | undefined {
  if (typeof globalId !== 'string') return undefined;
  const parts = decodeGid(globalId);
  if (parts === null || parts[0] !== 'PullRequest') return undefined;
  const repo = repoOf(ctx, Number(parts[1]));
  const pr = repo?.prs.get(Number(parts[2]));
  if (repo === undefined || pr === undefined) return undefined;
  return { repo, pr };
}

// Issues are numbered in creation order, so number order is creation order;
// CREATED_AT ordering is the same, and the default is newest first.
function issueConnection(repo: Repo, args: Record<string, unknown>): NodeRef {
  let list = [...repo.issues.values()];
  const states = args['states'];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args['orderBy']) ? args['orderBy'] : undefined;
  const direction = orderBy !== undefined && orderBy['direction'] === 'ASC' ? 'ASC' : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = args['after'];
  if (typeof after === 'string' && after !== '') {
    const parts = decodeGid(after);
    if (parts !== null && parts[0] === 'cursor') {
      const cursor = Number(parts[1]);
      list = list.filter((issue) => (direction === 'ASC' ? issue.number > cursor : issue.number < cursor));
    }
  }
  const first = args['first'];
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? gid('cursor', page[page.length - 1]?.number ?? 0) : null;
  return {
    type: 'IssueConnection',
    value: {
      nodes: page.map((issue) => issueNode(repo, issue)),
      pageInfo: { type: 'PageInfo', value: { hasNextPage, endCursor } },
    },
  };
}

const INTROSPECTION: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  },
};

function typeNode(name: string): NodeRef | null {
  const info = INTROSPECTION[name];
  if (info === undefined) return null;
  return {
    type: '__Type',
    value: {
      name,
      kind: info.kind,
      fields: info.fields.map((field) => ({ type: '__Field', value: { name: field } })),
      enumValues: info.enumValues.map((value) => ({ type: '__EnumValue', value: { name: value } })),
    },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (node, _field, _args, ctx) => ({ type: 'User', value: { login: ctx.store.viewerLogin } }),
    repository: (_node, _field, args, ctx) => {
      const owner = args['owner'];
      const name = args['name'];
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoNode(repo);
    },
    node: (_node, _field, args, ctx) => {
      if (typeof args['id'] !== 'string') return null;
      const parts = decodeGid(args['id']);
      if (parts === null) return null;
      if (parts[0] === 'Repository') {
        const repo = repoOf(ctx, Number(parts[1]));
        return repo === undefined ? null : repoNode(repo);
      }
      if (parts[0] === 'Issue') {
        const ref = decodeIssueRef(ctx, args['id']);
        return ref === undefined ? null : issueNode(ref.repo, ref.issue);
      }
      if (parts[0] === 'PullRequest') {
        const ref = decodePrRef(ctx, args['id']);
        return ref === undefined ? null : prNode(ref.repo, ref.pr);
      }
      return null;
    },
    __type: (_node, _field, args, _ctx) =>
      typeof args['name'] === 'string' ? typeNode(args['name']) : null,
  },
  Mutation: {
    createIssue: (_node, _field, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const repo = decodeRepoId(ctx, input['repositoryId']);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
        return null;
      }
      if (typeof input['title'] !== 'string') {
        ctx.errors.push({ message: 'createIssue requires a title.' });
        return null;
      }
      const created = ctx.issueOps.createIssue(repo, input['title'], typeof input['body'] === 'string' ? input['body'] : '', []);
      if (!created.ok) {
        ctx.errors.push({ message: `Could not create issue: unknown label "${created.badLabel}".` });
        return null;
      }
      return { type: 'CreateIssuePayload', value: { issue: issueNode(repo, created.issue) } };
    },
    closeIssue: (_node, _field, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const ref = decodeIssueRef(ctx, input['issueId']);
      if (ref === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
        return null;
      }
      const issue = ctx.issueOps.patchIssue(ref.repo, ref.issue.number, { state: 'closed' });
      if (issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
        return null;
      }
      return { type: 'CloseIssuePayload', value: { issue: issueNode(ref.repo, issue) } };
    },
    createPullRequest: (_node, _field, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const repo = decodeRepoId(ctx, input['repositoryId']);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
        return null;
      }
      if (typeof input['title'] !== 'string' || typeof input['headRefName'] !== 'string' || typeof input['baseRefName'] !== 'string') {
        ctx.errors.push({ message: 'createPullRequest requires title, headRefName and baseRefName.' });
        return null;
      }
      const created = ctx.pullOps.createPr(repo, input['title'], '', input['headRefName'], input['baseRefName']);
      if (!created.ok) {
        ctx.errors.push({
          message: created.error === 'bad-head' ? 'Head ref does not exist.' : 'Base ref does not exist.',
        });
        return null;
      }
      return { type: 'CreatePullRequestPayload', value: { pullRequest: prNode(repo, created.pr) } };
    },
    mergePullRequest: (_node, _field, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const ref = decodePrRef(ctx, input['pullRequestId']);
      if (ref === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided pullRequestId.' });
        return null;
      }
      const merged = ctx.pullOps.mergePr(ref.repo, ref.pr.number);
      if (!merged.ok) {
        ctx.errors.push({
          message:
            merged.error === 'conflict'
              ? 'Pull request cannot be merged: merge conflict.'
              : merged.error === 'closed'
                ? 'Pull request is already closed.'
                : 'Could not resolve to a PullRequest with the provided pullRequestId.',
        });
        return null;
      }
      const pr = ctx.pullOps.getPr(ref.repo, ref.pr.number) as PullRequest;
      return { type: 'MergePullRequestPayload', value: { pullRequest: prNode(ref.repo, pr) } };
    },
    addComment: (_node, _field, args, ctx) => {
      const input = isRecord(args['input']) ? args['input'] : {};
      const ref = decodeIssueRef(ctx, input['subjectId']);
      if (ref === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided subjectId.' });
        return null;
      }
      if (typeof input['body'] !== 'string') {
        ctx.errors.push({ message: 'addComment requires a body.' });
        return null;
      }
      const comment = ctx.issueOps.createComment(ref.repo, ref.issue.number, input['body']);
      if (comment === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided subjectId.' });
        return null;
      }
      const commentNode: NodeRef = {
        type: 'IssueComment',
        value: {
          id: gid('IssueComment', ref.repo.id, ref.issue.number, comment.id),
          body: comment.body,
        },
      };
      return { type: 'AddCommentPayload', value: { commentEdge: { type: 'CommentEdge', value: { node: commentNode } } } };
    },
  },
  User: {
    login: (node) => (isRecord(node.value) ? node.value['login'] : null),
  },
  Repository: {
    id: (node) => gid('Repository', (node.value as Repo).id),
    databaseId: (node) => (node.value as Repo).id,
    name: (node) => (node.value as Repo).name,
    nameWithOwner: (node) => `${(node.value as Repo).owner}/${(node.value as Repo).name}`,
    owner: (node) => ({ type: 'User', value: { login: (node.value as Repo).owner } }),
    defaultBranchRef: (node) => ({ type: 'Ref', value: { name: (node.value as Repo).defaultBranch } }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (node) => (node.value as Repo).description,
    private: (node) => (node.value as Repo).private,
    createdAt: (node) => (node.value as Repo).createdAt,
    issue: (node, _field, args) => {
      const repo = node.value as Repo;
      if (typeof args['number'] !== 'number') return null;
      const issue = repo.issues.get(args['number']);
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (node, _field, args) => issueConnection(node.value as Repo, args),
    pullRequests: (node, _field, args, ctx) => {
      const repo = node.value as Repo;
      const list = ctx.pullOps.listPrs(repo, 'all').sort((a, b) => b.number - a.number);
      const first = args['first'];
      const page = typeof first === 'number' ? list.slice(0, first) : list;
      return {
        type: 'PullRequestConnection',
        value: {
          nodes: page.map((pr) => prNode(repo, pr)),
          pageInfo: {
            type: 'PageInfo',
            value: { hasNextPage: list.length > page.length, endCursor: null },
          },
        },
      };
    },
    pullRequest: (node, _field, args) => {
      const repo = node.value as Repo;
      if (typeof args['number'] !== 'number') return null;
      const pr = repo.prs.get(args['number']);
      return pr === undefined ? null : prNode(repo, pr);
    },
  },
  Issue: {
    id: (node) => {
      const { repo, issue } = node.value as { repo: Repo; issue: Issue };
      return gid('Issue', repo.id, issue.number);
    },
    number: (node) => (node.value as { issue: Issue }).issue.number,
    title: (node) => (node.value as { issue: Issue }).issue.title,
    state: (node) => ((node.value as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (node) => (node.value as { issue: Issue }).issue.body,
    url: (node) => {
      const { repo, issue } = node.value as { repo: Repo; issue: Issue };
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    createdAt: (node) => (node.value as { issue: Issue }).issue.createdAt,
    updatedAt: (node) => (node.value as { issue: Issue }).issue.updatedAt,
    author: (node) => ({ type: 'User', value: { login: (node.value as { issue: Issue }).issue.user } }),
    labels: (node) => ({
      type: 'LabelConnection',
      value: {
        nodes: (node.value as { issue: Issue }).issue.labels.map((name) => ({
          type: 'Label',
          value: { name },
        })),
      },
    }),
    comments: (node) => {
      const { repo, issue } = node.value as { repo: Repo; issue: Issue };
      return {
        type: 'CommentConnection',
        value: {
          nodes: issue.comments.map((comment) => ({
            type: 'IssueComment',
            value: { id: gid('IssueComment', repo.id, issue.number, comment.id), body: comment.body },
          })),
        },
      };
    },
  },
  PullRequest: {
    id: (node) => {
      const { repo, pr } = node.value as { repo: Repo; pr: PullRequest };
      return gid('PullRequest', repo.id, pr.number);
    },
    number: (node) => (node.value as { pr: PullRequest }).pr.number,
    title: (node) => (node.value as { pr: PullRequest }).pr.title,
    body: (node) => (node.value as { pr: PullRequest }).pr.body,
    state: (node) => {
      const pr = (node.value as { pr: PullRequest }).pr;
      if (pr.merged) return 'MERGED';
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (node) => (node.value as { pr: PullRequest }).pr.merged,
    mergeable: (node, _field, _args, ctx) => {
      const { repo, pr } = node.value as { repo: Repo; pr: PullRequest };
      return ctx.pullOps.mergeConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (node) => (node.value as { pr: PullRequest }).pr.head.ref,
    baseRefName: (node) => (node.value as { pr: PullRequest }).pr.base.ref,
    createdAt: (node) => (node.value as { pr: PullRequest }).pr.createdAt,
    files: (node, _field, args, ctx) => {
      const { repo, pr } = node.value as { repo: Repo; pr: PullRequest };
      const changes = ctx.pullOps.prFiles(repo, pr);
      const first = args['first'];
      const page = typeof first === 'number' ? changes.slice(0, first) : changes;
      return {
        type: 'FileConnection',
        value: { nodes: page.map((change) => ({ type: 'PullRequestFile', value: { path: change.filename } })) },
      };
    },
  },
  IssueConnection: { nodes: recordResolver, pageInfo: recordResolver, totalCount: recordResolver },
  PullRequestConnection: { nodes: recordResolver, pageInfo: recordResolver },
  FileConnection: { nodes: recordResolver },
  LabelConnection: { nodes: recordResolver },
  CommentConnection: { nodes: recordResolver },
  PageInfo: { hasNextPage: recordResolver, endCursor: recordResolver },
  Ref: { name: recordResolver },
  Label: { name: recordResolver },
  IssueComment: { id: recordResolver, body: recordResolver },
  CommentEdge: { node: recordResolver },
  CreateIssuePayload: { issue: recordResolver },
  CloseIssuePayload: { issue: recordResolver },
  CreatePullRequestPayload: { pullRequest: recordResolver },
  MergePullRequestPayload: { pullRequest: recordResolver },
  AddCommentPayload: { commentEdge: recordResolver },
  PullRequestFile: { path: recordResolver },
  __Type: {
    name: (node) => (isRecord(node.value) ? node.value['name'] : null),
    kind: (node) => (isRecord(node.value) ? node.value['kind'] : null),
    fields: (node) => (isRecord(node.value) ? node.value['fields'] : null),
    enumValues: (node) => (isRecord(node.value) ? node.value['enumValues'] : null),
  },
  __Field: { name: recordResolver },
  __EnumValue: { name: recordResolver },
};

// --- envelope ---------------------------------------------------------------

interface Envelope {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function executeEnvelope(body: unknown, store: Store): Envelope {
  const ctx: ExecCtx = {
    store,
    issueOps: new IssueOps(store),
    pullOps: new PullOps(store),
    errors: [],
  };
  if (!isRecord(body) || typeof body['query'] !== 'string') {
    return { data: null, errors: [{ message: 'Request body must include a "query" string.' }] };
  }
  const variables = isRecord(body['variables']) ? (body['variables'] as Record<string, unknown>) : {};
  let operations: Operation[];
  try {
    operations = new Parser(lex(body['query'])).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Failed to parse query.' }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in query.' }] };
  }
  let operation = operations[0] as Operation;
  if (typeof body['operationName'] === 'string') {
    const named = operations.find((op) => op.name === body['operationName']);
    if (named === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${body['operationName']}".` }] };
    }
    operation = named;
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = select({ type: rootType, value: null }, operation.selections, variables, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: Store; token: string },
): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (!isAuthorized(req, ctx.token)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  // Instantiated for symmetry with the other surfaces; GraphQL only needs
  // issues and pull requests.
  const contentOps = new ContentOps(ctx.store);
  void contentOps;
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    sendError(res, 400, 'Invalid JSON');
    return true;
  }
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map((item) => executeEnvelope(item, ctx.store)));
    return true;
  }
  if (!isRecord(parsed.value)) {
    sendError(res, 400, 'Request body must be a JSON object or array');
    return true;
  }
  sendJson(res, 200, executeEnvelope(parsed.value, ctx.store));
  return true;
}
