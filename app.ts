// The HTTP server: one router over the four surfaces, plus the health probe.
// Dispatch order matters only for the fallback: a request is tried against
// git, REST, GraphQL and MCP in turn, and anything else is GitHub's 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { pathOf, sendError, sendJson } from './http-util.ts';
import { Store } from './store.ts';

export interface AppContext {
  store: Store;
  token: string;
}

export function createApp(ctx: AppContext): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleGit(req, res, ctx)) return;
        if (await handleRest(req, res, ctx)) return;
        if (await handleGraphql(req, res, ctx)) return;
        if (await handleMcp(req, res, ctx)) return;

        sendError(res, 404, 'Not Found');
      } catch {
        // A handler must never take the process down with it: the suite
        // keeps talking to a live server after every refused or malformed
        // request, so an unexpected failure is a JSON 500, not a crash.
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.destroy();
      }
    })();
  });
}
