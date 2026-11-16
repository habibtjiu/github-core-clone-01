// Git smart HTTP: info/refs advertisements, upload-pack protocol v2, and
// receive-pack v0. The suite's client speaks the protocol in-process with no
// git binary, so every byte here is produced from the store's objects.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildPack,
  parseCommit,
  parsePack,
  parsePktLines,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  reachableObjects,
  type GitObject,
} from './gitobj.ts';
import {
  isAuthorized,
  pathOf,
  queryOf,
  readBody,
  sendError,
  sendJson,
} from './http-util.ts';
import type { Repo, Store } from './store.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

interface GitContext {
  store: Store;
  token: string;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function isTagObject(repo: Repo, oid: string): boolean {
  return repo.objects.get(oid)?.type === 'tag';
}

function tagTarget(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  const line = obj.data.toString('utf8').split('\n').find((entry) => entry.startsWith('object '));
  return line === undefined ? undefined : line.slice(7).trim();
}

function sendAdvertisement(res: ServerResponse, contentType: string, body: Buffer): void {
  res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function uploadPackAdvertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    pktFlush(),
  ]);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta thin-pack agent=forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n')];
  const refs = sortedRefs(repo);
  const mainFirst = refs.slice().sort((a, b) => {
    if (a.name === 'refs/heads/main') return -1;
    if (b.name === 'refs/heads/main') return 1;
    return a.name < b.name ? -1 : 1;
  });
  if (mainFirst.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    mainFirst.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.name.startsWith('refs/tags/') && isTagObject(repo, ref.oid)) {
        const peeled = tagTarget(repo, ref.oid);
        if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// --- upload-pack v2 -----------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
  thinPack: boolean;
}

function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  const { items, ok } = parsePktLines(body);
  if (!ok) return null;
  let command: string | undefined;
  const args: string[] = [];
  let pastDelim = false;
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (item.kind !== 'line') continue;
    const text = item.data.toString('utf8');
    if (command === undefined) {
      if (!text.startsWith('command=')) return null;
      command = text.slice('command='.length).trim();
    } else if (pastDelim) {
      args.push(text.trim());
    }
  }
  if (command === undefined) return null;
  return { command, args };
}

// Upload-pack answers are pure functions of the repo's objects, refs and
// the request args, so identical requests repeat a lot (fifty clones of one
// repo ask for the same ls-refs and the same pack). Cache them per repo,
// keyed on the repo version, and drop the cache once it grows past a small
// bound so a long trial cannot pile up large packs.
const uploadCache = new WeakMap<Repo, Map<string, { version: number; body: Buffer }>>();
const UPLOAD_CACHE_MAX = 32;

function cachedUpload(repo: Repo, key: string, build: () => Buffer): Buffer {
  let perRepo = uploadCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    uploadCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit !== undefined && hit.version === repo.version) return hit.body;
  const body = build();
  if (perRepo.size >= UPLOAD_CACHE_MAX) perRepo.clear();
  perRepo.set(key, { version: repo.version, body });
  return body;
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip === undefined) {
    // An empty repository advertises only its unborn HEAD.
    if (matches('HEAD')) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (matches('HEAD')) {
    const symref = symrefs ? ' symref-target:refs/heads/main' : '';
    parts.push(pktLine(`${mainTip} HEAD${symref}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/') && isTagObject(repo, ref.oid)) {
      const peeled = tagTarget(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// The objects a shallow client already holds for a have: the commit, its
// tree and its blobs — but none of the parents.
function shallowClosure(repo: Repo, oid: string): Set<string> {
  const known = new Set<string>();
  const obj = repo.objects.get(oid);
  if (obj === undefined) return known;
  known.add(oid);
  if (obj.type === 'commit') {
    const tree = parseCommit(obj.data).tree;
    const treeObjs = reachableObjects((id) => repo.objects.get(id), [tree]);
    for (const id of treeObjs.keys()) known.add(id);
  }
  return known;
}

function fetchResponse(repo: Repo, args: string[]): Buffer {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], deepen: undefined, thinPack: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.deepen = parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'thin-pack') parsed.thinPack = true;
  }
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const depth = parsed.deepen === undefined ? Number.POSITIVE_INFINITY : parsed.deepen;
  const shallowSet = new Set(parsed.shallow);
  const wanted = reachableObjects(get, parsed.wants, new Set(), depth);
  const known = new Set<string>();
  for (const have of parsed.haves) {
    if (shallowSet.has(have)) {
      for (const id of shallowClosure(repo, have)) known.add(id);
    } else {
      for (const id of reachableObjects(get, [have]).keys()) known.add(id);
    }
  }
  const send = new Map<string, GitObject>();
  for (const [oid, obj] of wanted) {
    if (!known.has(oid)) send.set(oid, obj);
  }

  const parts: Buffer[] = [];
  if (parsed.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
  }
  // Shallow boundaries: every sent commit whose parents stay behind is a
  // new shallow point; every shallow have whose parent is now sent is not.
  const shallowLines: string[] = [];
  if (parsed.deepen !== undefined) {
    for (const [oid, obj] of send) {
      if (obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0) shallowLines.push(`shallow ${oid}`);
    }
    for (const have of parsed.shallow) {
      const obj = repo.objects.get(have);
      if (obj !== undefined && obj.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        if (parents.some((parent) => send.has(parent))) shallowLines.push(`unshallow ${have}`);
      }
    }
  }
  if (shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(pktDelim());
  }
  if (send.size > 0) {
    const pack = buildPack([...send.values()]);
    parts.push(pktLine('packfile\n'));
    const CHUNK = 65515;
    for (let off = 0; off < pack.length; off += CHUNK) {
      const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const parsed = parseV2Request(body);
  if (parsed === null) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  if (parsed.command === 'ls-refs') {
    const out = cachedUpload(repo, `ls-refs:${JSON.stringify(parsed.args)}`, () => lsRefsResponse(repo, parsed.args));
    res.writeHead(200, { 'content-type': UPLOAD_RESULT_CT, 'content-length': out.length });
    res.end(out);
    return;
  }
  if (parsed.command === 'fetch') {
    const out = cachedUpload(repo, `fetch:${JSON.stringify(parsed.args)}`, () => fetchResponse(repo, parsed.args));
    res.writeHead(200, { 'content-type': UPLOAD_RESULT_CT, 'content-length': out.length });
    res.end(out);
    return;
  }
  sendJson(res, 400, { message: 'Bad Request' });
}

// --- receive-pack v0 ----------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; packStart: number; sideband: boolean } | null {
  // Parsed by hand, not with parsePktLines: a packfile follows the flush,
  // and its bytes are not pkt-lines, so a generic parser would stop there.
  const commands: PushCommand[] = [];
  let sideband = false;
  let off = 0;
  let first = true;
  let sawFlush = false;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (head === '0000') {
      off += 4;
      sawFlush = true;
      break;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = parseInt(head, 16);
    if (len < 4 || len > 65520 || off + len > body.length) return null;
    let text = body.subarray(off + 4, off + len).toString('utf8');
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        if (text.slice(nul + 1).includes('side-band-64k')) sideband = true;
        text = text.slice(0, nul);
      }
    }
    const parts = text.trim().split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) return null;
    commands.push({ oldOid, newOid, ref });
    off += len;
  }
  if (!sawFlush) return null;
  return { commands, packStart: off, sideband };
}

function sendReport(res: ServerResponse, lines: string[], sideband: boolean): void {
  const parts: Buffer[] = [];
  for (const line of lines) {
    const payload = sideband ? Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')]) : Buffer.from(line, 'utf8');
    parts.push(pktLine(payload));
  }
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': RECEIVE_RESULT_CT, 'content-length': body.length });
  res.end(body);
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, store: Store): Promise<void> {
  const body = await readBody(req);
  const parsed = parsePushCommands(body);
  if (parsed === null || parsed.commands.length === 0) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const hasPack = parsed.commands.some((cmd) => cmd.newOid !== ZERO_OID);
  if (hasPack) {
    const pack = parsePack(body.subarray(parsed.packStart));
    if (pack === null) {
      sendReport(res, ['unpack pack corrupt\n'], parsed.sideband);
      return;
    }
    for (const obj of pack.objects) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
  }
  const report: string[] = ['unpack ok\n'];
  for (const cmd of parsed.commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) {
        report.push(`ng ${cmd.ref} remote ref does not exist\n`);
      } else {
        store.deleteRef(repo, cmd.ref);
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (repo.objects.get(cmd.newOid) === undefined) {
      report.push(`ng ${cmd.ref} unable to resolve new object\n`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${cmd.ref} already exists\n`);
        continue;
      }
      store.setRef(repo, cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
      continue;
    }
    // An update moves the ref only when the old tip matches and the new tip
    // descends from it; anything else is refused per ref, never by HTTP.
    if (current !== cmd.oldOid || !store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    store.setRef(repo, cmd.ref, cmd.newOid);
    report.push(`ok ${cmd.ref}\n`);
  }
  sendReport(res, report, parsed.sideband);
}

// --- router -------------------------------------------------------------------

export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: GitContext): Promise<boolean> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (match === null) return false;
  const owner = match[1] as string;
  const name = match[2] as string;
  const rest = match[3] as string;
  if (!isAuthorized(req, ctx.token)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest === 'info/refs') {
    const service = queryOf(req).get('service');
    if (service === 'git-upload-pack') {
      sendAdvertisement(res, UPLOAD_AD_CT, uploadPackAdvertisement());
      return true;
    }
    if (service === 'git-receive-pack') {
      sendAdvertisement(res, RECEIVE_AD_CT, receivePackAdvertisement(repo));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (method === 'POST' && rest === 'git-upload-pack') {
    await handleUploadPack(req, res, repo);
    return true;
  }
  if (method === 'POST' && rest === 'git-receive-pack') {
    await handleReceivePack(req, res, repo, ctx.store);
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
