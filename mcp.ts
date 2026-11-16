// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
// One JSON-RPC response per request, no SSE. Reads and writes the same
// Store instance as the REST surface, so objects created here are visible
// there with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ContentOps, IssueOps, PullOps, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { isAuthorized, parseJson, pathOf, readBody, sendError, sendJson, sendStatus } from './http-util.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

type JsonRecord = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Fixed tool list: no timestamps or randomness, byte-identical every call.
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Owner login; ignored, the repository is always owned by the authenticated user.' },
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
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
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
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body text.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all. Defaults to open.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body text.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): JsonRecord {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): JsonRecord {
  const error: JsonRecord = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

// Best-effort id recovery from unparsable text, per the parse-error contract.
function extractId(raw: string): string | number | null {
  const match = /"id"\s*:\s*("[^"]*"|\d+)/.exec(raw);
  if (match === null) return null;
  const token = match[1] as string;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  return Number(token);
}

// First present string among the given keys; accepts common synonyms.
function argStr(args: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function argBool(args: JsonRecord, key: string): boolean {
  return args[key] === true;
}

function argInt(args: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

// owner/repo from canonical names, synonyms, or a "owner/repo" full_name.
function resolveOwnerRepo(args: JsonRecord): { owner: string; repo: string } | undefined {
  let owner = argStr(args, ['owner']);
  let repo = argStr(args, ['repo', 'repository', 'repo_name']);
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === undefined) owner = parts[0] as string;
      if (repo === undefined) repo = parts[1] as string;
    }
  }
  if (owner === undefined || repo === undefined) return undefined;
  return { owner, repo };
}

function repoView(repo: Repo): JsonRecord {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueView(issue: Issue): JsonRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.slice(),
    url: '',
  };
}

function prView(pr: PullRequest): JsonRecord {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
  };
}

function toolResult(obj: JsonRecord): JsonRecord {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}

function toolError(obj: JsonRecord): JsonRecord {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: true,
  };
}

class InvalidParams extends Error {}

function requireArgs(args: JsonRecord | undefined): JsonRecord {
  if (args === undefined) throw new InvalidParams('Missing arguments');
  return args;
}

function requireStr(args: JsonRecord, keys: readonly string[]): string {
  const value = argStr(args, keys);
  if (value === undefined) throw new InvalidParams(`Missing required argument: ${keys[0] as string}`);
  return value;
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: Store; token: string },
): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;

  // Auth applies to every /mcp request, including discover and DELETE.
  if (!isAuthorized(req, ctx.token)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }

  // Session close is best-effort; no session state is kept.
  if (req.method === 'DELETE') {
    sendStatus(res, 202);
    return true;
  }

  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }

  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    sendJson(res, 400, rpcError(extractId(raw.toString('utf8')), -32700, 'Parse error'));
    return true;
  }
  if (!isRecord(parsed.value)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }

  const request = parsed.value;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    sendJson(res, 400, rpcError('id' in request ? request.id : null, -32600, 'Invalid Request'));
    return true;
  }

  // A JSON-RPC request without an "id" is a notification: no response.
  if (!('id' in request)) {
    sendStatus(res, 202);
    return true;
  }
  const id = request.id;

  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    // A version the client asks for via header that we do not support is a
    // -32022 error carrying the versions we do support.
    const header = req.headers['mcp-protocol-version'];
    const requested = Array.isArray(header) ? header[0] : header;
    if (requested !== undefined && requested !== PROTOCOL_VERSION) {
      sendJson(res, 200, rpcError(id, -32022, 'Unsupported protocol version', { supported: [PROTOCOL_VERSION] }));
      return true;
    }
    sendJson(res, 200, rpcResult(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const version = requested !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PROTOCOL_VERSION;
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return true;
  }

  if (method === 'notifications/initialized') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === 'tools/call') {
    const store = ctx.store;
    const issueOps = new IssueOps(store);
    const pullOps = new PullOps(store);
    // Instantiated for parity: every surface builds its ops from this store.
    const contentOps = new ContentOps(store);
    void contentOps;

    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : undefined;
    try {
      const result = callTool(name, args, store, issueOps, pullOps);
      sendJson(res, 200, rpcResult(id, result));
    } catch (error) {
      if (error instanceof InvalidParams) {
        sendJson(res, 200, rpcError(id, -32602, error.message));
      } else if (name === '') {
        sendJson(res, 200, rpcError(id, -32602, 'Missing tool name'));
      } else {
        sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
      }
    }
    return true;
  }

  sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
  return true;
}

function callTool(
  name: string,
  args: JsonRecord | undefined,
  store: Store,
  issueOps: IssueOps,
  pullOps: PullOps,
): JsonRecord {
  switch (name) {
    case 'create_repo': {
      const a = requireArgs(args);
      const repoName = requireStr(a, ['name']);
      const repo = store.createRepo(repoName, argStr(a, ['description']) ?? '', argBool(a, 'private'));
      if (repo === null) return toolError({ error: 'already exists' });
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const a = requireArgs(args);
      const target = resolveOwnerRepo(a);
      if (target === undefined) throw new InvalidParams('Missing required argument: owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError({ error: 'not found' });
      return toolResult(repoView(repo));
    }
    case 'create_issue': {
      const a = requireArgs(args);
      const target = resolveOwnerRepo(a);
      if (target === undefined) throw new InvalidParams('Missing required argument: owner/repo');
      const title = requireStr(a, ['title']);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError({ error: 'not found' });
      const created = issueOps.createIssue(repo, title, argStr(a, ['body']) ?? '', []);
      if (!created.ok) return toolError({ error: 'not found' });
      return toolResult(issueView(created.issue));
    }
    case 'list_issues': {
      const a = requireArgs(args);
      const target = resolveOwnerRepo(a);
      if (target === undefined) throw new InvalidParams('Missing required argument: owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError({ error: 'not found' });
      const state = argStr(a, ['state']);
      const filter = state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open';
      const issues = issueOps.listIssues(repo, filter, 'asc');
      return toolResult({ issues: issues.map((issue) => issueView(issue)) });
    }
    case 'create_pull_request': {
      const a = requireArgs(args);
      const target = resolveOwnerRepo(a);
      if (target === undefined) throw new InvalidParams('Missing required argument: owner/repo');
      const title = requireStr(a, ['title']);
      const head = requireStr(a, ['head', 'head_ref', 'head_branch']);
      const base = requireStr(a, ['base', 'base_ref', 'base_branch']);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError({ error: 'not found' });
      const created = pullOps.createPr(repo, title, argStr(a, ['body']) ?? '', head, base);
      if (!created.ok) return toolError({ error: created.error });
      return toolResult(prView(created.pr));
    }
    case 'merge_pull_request': {
      const a = requireArgs(args);
      const target = resolveOwnerRepo(a);
      if (target === undefined) throw new InvalidParams('Missing required argument: owner/repo');
      const number = argInt(a, ['pull_number', 'number']);
      if (number === undefined) throw new InvalidParams('Missing required argument: pull_number');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError({ error: 'not found' });
      const merged = pullOps.mergePr(repo, number);
      if (!merged.ok) return toolError({ error: merged.error });
      return toolResult({ merged: true, sha: merged.sha, number });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
