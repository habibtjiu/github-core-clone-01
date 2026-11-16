// REST v3 surface: thin translation between GitHub-shaped JSON and the store.
// Auth, routing and shaping live here; git, issue and PR rules live in store.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  baseUrlOf,
  isAuthorized,
  parseJson,
  pathOf,
  queryOf,
  readBody,
  sendError,
  sendJson,
  sendStatus,
} from './http-util.ts';
import { ContentOps, IssueOps, PullOps } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

type JsonObject = Record<string, unknown>;

function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

// Split on '/' first, then decode each segment: a client encodes spaces etc.
// per segment while '/' stays the separator.
function segments(path: string): string[] | undefined {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '') continue;
    const decoded = decodeSegment(part);
    if (decoded === undefined) return undefined;
    out.push(decoded);
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    out.push(item);
  }
  return out;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  return {
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    perPage: Number.isFinite(perRaw) && perRaw > 0 ? perRaw : 30,
  };
}

// Buffer.from never rejects bad base64, so validate by round-tripping.
function decodeBase64(text: string): Buffer | undefined {
  const clean = text.replace(/\s/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return undefined;
  const buf = Buffer.from(clean, 'base64');
  if (buf.toString('base64') !== clean) return undefined;
  return buf;
}

function repoJson(repo: Repo, base: string): JsonObject {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): JsonObject {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label === undefined ? '' : label.color };
    }),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function prJson(repo: Repo, pr: PullRequest): JsonObject {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head.ref, sha: pr.head.sha, label: `${repo.owner}:${pr.head.ref}` },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: `${repo.owner}:${pr.base.ref}` },
    user: { login: repo.owner },
    created_at: pr.createdAt,
  };
}

function isNumberSegment(value: string): boolean {
  return /^\d+$/.test(value);
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: Store; token: string },
): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';
  const store = ctx.store;

  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (!isAuthorized(req, ctx.token)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }

  const segs = segments(path);
  if (segs === undefined) {
    sendError(res, 400, 'Bad Request');
    return true;
  }
  const query = queryOf(req);
  const base = baseUrlOf(req);
  const contentOps = new ContentOps(store);
  const issueOps = new IssueOps(store);
  const pullOps = new PullOps(store);

  // Read the body once for every method that may carry one, so a malformed
  // payload is a 400 before routing and DELETE-with-body works.
  let body: JsonObject = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      const parsed = parseJson(raw);
      if (!parsed.ok) {
        sendError(res, 400, 'Malformed JSON');
        return true;
      }
      const value = parsed.value;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        sendError(res, 400, 'Malformed JSON');
        return true;
      }
      body = value as JsonObject;
    }
  }

  if (segs.length === 3 && segs[2] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      login: store.viewerLogin,
      id: 1000,
      name: store.viewerName,
      email: store.viewerEmail,
      type: 'User',
    });
    return true;
  }

  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'Repository name is required');
        return true;
      }
      const repo = store.createRepo(name, asString(body.description) ?? '', body.private === true);
      if (repo === null) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, 201, repoJson(repo, base));
      return true;
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const all = store.listRepos();
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        headers.link = `<${base}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
      sendJson(
        res,
        200,
        items.map((repo) => repoJson(repo, base)),
        headers,
      );
      return true;
    }
  }

  if (segs.length >= 5 && segs[2] === 'repos') {
    // getRepo already hides other owners as missing, never as forbidden.
    const repo = store.getRepo(segs[3], segs[4]);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const rest = segs.slice(5);

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo, base));
        return true;
      }
      if (method === 'PATCH') {
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        sendJson(res, 200, repoJson(repo, base));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(segs[3], segs[4]);
        sendStatus(res, 204);
        return true;
      }
    }

    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || sha === '') {
        sendError(res, 422, 'Invalid ref');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      if (store.getObject(repo, sha) === undefined) {
        sendError(res, 422, 'Object does not exist');
        return true;
      }
      store.setRef(repo, ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }

    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      sendJson(
        res,
        200,
        contentOps.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })),
      );
      return true;
    }

    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const branch = query.get('sha') ?? undefined;
      sendJson(
        res,
        200,
        contentOps.listCommits(repo, branch).map((commit) => ({
          sha: commit.sha,
          commit: {
            message: commit.message,
            author: { name: store.viewerName, email: store.viewerEmail },
            committer: { name: store.viewerName, email: store.viewerEmail },
          },
          author: { login: store.viewerLogin },
          committer: { login: store.viewerLogin },
        })),
      );
      return true;
    }

    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const result = contentOps.getContent(repo, filePath, query.get('ref') ?? undefined);
        if (!result.ok) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (result.kind === 'file') {
          const name = filePath.split('/').pop() ?? filePath;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: result.content.toString('base64'),
            sha: result.sha,
            size: result.size,
            name,
            path: filePath,
          });
          return true;
        }
        sendJson(res, 200, result.entries);
        return true;
      }
      if (method === 'PUT') {
        if (filePath === '') {
          sendError(res, 422, 'Missing path');
          return true;
        }
        const content = asString(body.content);
        if (content === undefined) {
          sendError(res, 400, 'Missing content');
          return true;
        }
        const buf = decodeBase64(content);
        if (buf === undefined) {
          sendError(res, 400, 'Invalid base64 content');
          return true;
        }
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const result = contentOps.putContent(repo, filePath, buf, asString(body.message) ?? '', branch, asString(body.sha));
        if (!result.ok) {
          if (result.error === 'stale') {
            sendError(res, 409, 'Conflict');
            return true;
          }
          sendError(res, 400, 'Cannot write content');
          return true;
        }
        const name = filePath.split('/').pop() ?? filePath;
        sendJson(res, result.status, {
          content: { sha: result.contentSha, encoding: 'base64', name, path: filePath },
          commit: { sha: result.commitSha },
        });
        return true;
      }
      if (method === 'DELETE') {
        if (filePath === '') {
          sendError(res, 422, 'Missing path');
          return true;
        }
        const branch = query.get('ref') ?? repo.defaultBranch;
        const result = contentOps.deleteContent(repo, filePath, asString(body.message) ?? '', branch, asString(body.sha));
        if (!result.ok) {
          if (result.error === 'not-found') {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendError(res, 409, 'Conflict');
          return true;
        }
        sendJson(res, 200, { commit: { sha: result.commitSha } });
        return true;
      }
    }

    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const name = asString(body.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'Label name is required');
        return true;
      }
      const label = issueOps.createLabel(repo, name, asString(body.color) ?? 'ffffff');
      sendJson(res, 201, { name: label.name, color: label.color });
      return true;
    }

    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'POST') {
        const title = asString(body.title);
        if (title === undefined || title === '') {
          sendError(res, 422, 'Issue title is required');
          return true;
        }
        const labels = body.labels === undefined ? [] : asStringArray(body.labels);
        if (labels === undefined) {
          sendError(res, 422, 'Invalid labels');
          return true;
        }
        const result = issueOps.createIssue(repo, title, asString(body.body) ?? '', labels);
        if (!result.ok) {
          sendError(res, 422, `Label does not exist: ${result.badLabel}`);
          return true;
        }
        sendJson(res, 201, issueJson(repo, result.issue));
        return true;
      }
      if (method === 'GET') {
        const stateRaw = query.get('state') ?? 'open';
        const state: 'open' | 'closed' | 'all' = stateRaw === 'closed' || stateRaw === 'all' ? stateRaw : 'open';
        const direction: 'asc' | 'desc' = query.get('direction') === 'asc' ? 'asc' : 'desc';
        const { perPage } = pageParams(query);
        sendJson(
          res,
          200,
          issueOps
            .listIssues(repo, state, direction)
            .slice(0, perPage)
            .map((issue) => issueJson(repo, issue)),
        );
        return true;
      }
    }

    if (rest.length === 2 && rest[0] === 'issues') {
      if (!isNumberSegment(rest[1])) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const number = Number.parseInt(rest[1], 10);
      if (method === 'GET') {
        const issue = issueOps.getIssue(repo, number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const issue = issueOps.getIssue(repo, number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const state = asString(body.state);
        if (state !== undefined && state !== 'open' && state !== 'closed') {
          sendError(res, 422, 'Invalid state');
          return true;
        }
        const updated = issueOps.patchIssue(repo, number, {
          state: state as 'open' | 'closed' | undefined,
          title: asString(body.title),
          body: asString(body.body),
        }) ?? issue;
        sendJson(res, 200, issueJson(repo, updated));
        return true;
      }
    }

    if (rest.length === 3 && rest[0] === 'issues' && rest[2] === 'comments') {
      if (!isNumberSegment(rest[1])) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const number = Number.parseInt(rest[1], 10);
      if (method === 'GET') {
        const issue = issueOps.getIssue(repo, number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(
          res,
          200,
          issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: comment.user },
            created_at: comment.createdAt,
          })),
        );
        return true;
      }
      if (method === 'POST') {
        const text = asString(body.body);
        if (text === undefined) {
          sendError(res, 422, 'Comment body is required');
          return true;
        }
        const comment = issueOps.createComment(repo, number, text);
        if (comment === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 201, {
          id: comment.id,
          body: comment.body,
          user: { login: comment.user },
          created_at: comment.createdAt,
        });
        return true;
      }
    }

    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'POST') {
        const title = asString(body.title);
        const head = asString(body.head);
        const baseBranch = asString(body.base);
        if (title === undefined || title === '' || head === undefined || head === '' || baseBranch === undefined || baseBranch === '') {
          sendError(res, 422, 'Missing required fields');
          return true;
        }
        const result = pullOps.createPr(repo, title, asString(body.body) ?? '', head, baseBranch);
        if (!result.ok) {
          sendError(res, 422, result.error === 'bad-head' ? 'Head branch does not exist' : 'Base branch does not exist');
          return true;
        }
        sendJson(res, 201, prJson(repo, result.pr));
        return true;
      }
      if (method === 'GET') {
        const stateRaw = query.get('state');
        const state: 'open' | 'closed' | 'all' = stateRaw === 'all' || stateRaw === 'closed' ? stateRaw : 'open';
        const { perPage } = pageParams(query);
        sendJson(
          res,
          200,
          pullOps
            .listPrs(repo, state)
            .slice(0, perPage)
            .map((pr) => prJson(repo, pr)),
        );
        return true;
      }
    }

    if (rest.length === 2 && rest[0] === 'pulls' && method === 'GET') {
      if (!isNumberSegment(rest[1])) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pr = pullOps.getPr(repo, Number.parseInt(rest[1], 10));
      if (pr === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, prJson(repo, pr));
      return true;
    }

    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'files' && method === 'GET') {
      if (!isNumberSegment(rest[1])) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pr = pullOps.getPr(repo, Number.parseInt(rest[1], 10));
      if (pr === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(
        res,
        200,
        pullOps.prFiles(repo, pr).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        })),
      );
      return true;
    }

    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'merge' && method === 'PUT') {
      if (!isNumberSegment(rest[1])) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const result = pullOps.mergePr(repo, Number.parseInt(rest[1], 10));
      if (!result.ok) {
        if (result.error === 'not-found') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendError(res, 405, result.error === 'closed' ? 'Pull request is closed' : 'Merge conflict');
        return true;
      }
      sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
      return true;
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}
