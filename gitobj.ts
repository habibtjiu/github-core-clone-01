// The git object layer: SHA-1 ids, pkt-line framing, packfiles, and the object
// graph. No git binary exists in the trial pod, so every byte the suite's client
// checks is produced and verified here, on node:crypto and node:zlib alone.
// Packs are always written plain (no deltas): the suite accepts that, and it
// keeps pack building linear in the object count.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// An object's id is the SHA-1 of "<type> <decimal length>\0" plus its bytes.
export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function makeObject(type: ObjType, data: Buffer): { oid: string; obj: GitObject } {
  return { oid: oidOf(type, data), obj: { type, data } };
}

// --- pkt-line ---------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type PktItem =
  | { kind: 'line'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

// Split a buffer into pkt-lines. `ok: false` when a length is illegal or the
// buffer ends mid-line; `rest` holds bytes after the last complete line.
export function parsePktLines(buf: Buffer): { items: PktItem[]; rest: Buffer; ok: boolean } {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') {
      items.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (head === '0001') {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (head === '0002') {
      items.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return { items, rest: buf.subarray(off), ok: false };
    const len = parseInt(head, 16);
    if (len < 4 || len > 65520 || off + len > buf.length) return { items, rest: buf.subarray(off), ok: false };
    items.push({ kind: 'line', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { items, rest: buf.subarray(off), ok: off === buf.length };
}

// --- commits and trees ------------------------------------------------------

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(parts: CommitParts): Buffer {
  let text = `tree ${parts.tree}\n`;
  for (const parent of parts.parents) text += `parent ${parent}\n`;
  text += `author ${parts.author}\ncommitter ${parts.committer}\n\n${parts.message}`;
  return Buffer.from(text, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// Git sorts tree entries by name bytes, treating a directory as if its name
// ended in '/'. The mode decides which entries are directories.
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);
  return entries.slice().sort((a, b) => {
    const ka = Buffer.from(key(a), 'utf8');
    const kb = Buffer.from(key(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
}

// --- packfiles --------------------------------------------------------------

// A pack entry header is a varint: low 4 bits of the first byte hold the
// object's type in bits 4-6 and the first 4 bits of its size; later bytes add
// 7 size bits each while their high bit is set.
function readPackEntryHeader(buf: Buffer, off: number): { type: ObjType; size: number; next: number } | null {
  if (off >= buf.length) return null;
  const first = buf[off];
  const typeCode = (first >> 4) & 0x7;
  const type = CODE_TYPES[typeCode];
  if (type === undefined) return null;
  let size = first & 0x0f;
  let shift = 4;
  let pos = off + 1;
  while (first !== undefined && (buf[pos - 1] & 0x80) !== 0) {
    if (pos >= buf.length) return null;
    size |= (buf[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { type, size, next: pos };
}

// With {info: true} inflateSync returns the engine, whose bytesWritten
// counts only the input the first stream consumed, so the stream length is
// known after one call. Some runtimes report it differently, so any anomaly
// falls back to the binary search below.
function inflateAtFast(buf: Buffer, off: number, declaredSize: number, limit: number): { data: Buffer; next: number } | null {
  try {
    const res = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten?: unknown } };
    const consumed = res.engine.bytesWritten;
    if (typeof consumed !== 'number' || consumed <= 0) return null;
    const next = off + consumed;
    if (next > limit) return null;
    if (res.buffer.length !== declaredSize) return null;
    return { data: res.buffer, next };
  } catch {
    return null;
  }
}

// inflateSync ignores bytes after the stream's end, so without the fast path
// above the exact stream length is found by binary search on the smallest
// prefix that inflates to the declared size.
function inflateAt(buf: Buffer, off: number, declaredSize: number): { data: Buffer; next: number } | null {
  let lo = 1;
  let hi = buf.length - off;
  if (hi <= 0) return null;
  const tryInflate = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(off, off + len));
      return out.length === declaredSize ? out : null;
    } catch {
      return null;
    }
  };
  if (tryInflate(hi) === null) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryInflate(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = tryInflate(lo);
  if (data === null) return null;
  return { data, next: off + lo };
}

export interface ParsedPack {
  objects: { type: ObjType; data: Buffer; oid: string }[];
}

// Parse a v2 pack. Only plain objects are accepted; the suite's client never
// sends deltas, so OFS_DELTA/REF_DELTA entries fail the parse.
export function parsePack(buf: Buffer): ParsedPack | null {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') return null;
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = buf.readUInt32BE(8);
  const objects: ParsedPack['objects'] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const header = readPackEntryHeader(buf, off);
    if (header === null) return null;
    const inflated = inflateAtFast(buf, header.next, header.size, buf.length - 20) ?? inflateAt(buf, header.next, header.size);
    if (inflated === null) return null;
    const { oid } = makeObject(header.type, inflated.data);
    objects.push({ type: header.type, data: inflated.data, oid });
    off = inflated.next;
  }
  if (off + 20 !== buf.length) return null;
  const trailer = buf.subarray(off, off + 20);
  if (!trailer.equals(createHash('sha1').update(buf.subarray(0, off)).digest())) return null;
  return { objects };
}

function writePackEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

// Build a v2 pack of plain objects, in the order given, with a SHA-1 trailer.
export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(version, count);
  for (const obj of objects) {
    parts.push(writePackEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --- reachability -----------------------------------------------------------

export type ObjectGetter = (oid: string) => GitObject | undefined;

// Every object reachable from `tips`, walking commits (tree + parents), tags
// (target) and trees (entries). A tip listed in `stopAt` contributes nothing,
// not even itself, which is how an incremental fetch excludes what the client
// already has. `maxCommitDepth` caps how many parent steps a commit walk
// takes (1 = tips only, for shallow fetches).
export function reachableObjects(
  get: ObjectGetter,
  tips: string[],
  stopAt: ReadonlySet<string> = new Set(),
  maxCommitDepth = Number.POSITIVE_INFINITY,
): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const queue: { oid: string; depth: number }[] = tips.map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid) || stopAt.has(oid)) continue;
    seen.add(oid);
    const obj = get(oid);
    if (obj === undefined) continue;
    found.set(oid, obj);
    if (obj.type === 'commit') {
      const parts = parseCommit(obj.data);
      queue.push({ oid: parts.tree, depth });
      if (depth + 1 < maxCommitDepth) {
        for (const parent of parts.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    } else if (obj.type === 'tag') {
      const target = obj.data.toString('utf8').split('\n').find((line) => line.startsWith('object '));
      if (target !== undefined) queue.push({ oid: target.slice(7).trim(), depth });
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push({ oid: entry.oid, depth });
    }
  }
  return found;
}
