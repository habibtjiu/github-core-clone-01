// The one store every surface reads and writes: repositories, git objects and
// refs, issues, pull requests, labels and comments. Everything lives in
// memory — a trial starts empty, and no check needs data to survive a restart.
// Numbers (repo ids, issue/PR numbers, comment ids) come from plain counters
// in request order, never from a clock or Math.random, so a replayed trial
// assigns the same ids. Timestamps come from MAKEFUN_TRIAL_NOW alone.

import {
  ZERO_OID,
  type GitObject,
  type ObjType,
  buildCommit,
  buildTree,
  makeObject,
  parseCommit,
  parseTree,
  sortTreeEntries,
  type TreeEntry,
} from './gitobj.ts';
import { STRANGER, VIEWER } from './scenario.ts';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  seq: number;
  createdAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  branchFiles: Map<string, Map<string, string>>;
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  // Mutation counter: every object or ref change bumps it, so cached
  // responses keyed on it can never go stale.
  version: number;
  // Commit parents, parsed once per object; depths are memoized and
  // dropped whenever a commit lands, since a late parent changes them.
  parents: Map<string, string[]>;
  depth: Map<string, number>;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

const IDENTITY = `${VIEWER.login} <${VIEWER.email}>`;

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// A small line diff (longest common subsequence over lines) for the
// additions/deletions counts on pull request files. Files here are small.
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = countLines(oldText);
  const b = countLines(newText);
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: b.length - common, deletions: a.length - common };
}

export class Store {
  readonly viewerLogin = VIEWER.login;
  readonly viewerName = VIEWER.name;
  readonly viewerEmail = VIEWER.email;
  readonly strangerLogin = STRANGER.login;
  readonly nowIso: string;
  readonly nowEpoch: number;
  readonly repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPrId = 1;

  constructor(nowIso: string | undefined) {
    const parsed = nowIso !== undefined ? Date.parse(nowIso) : Number.NaN;
    if (Number.isFinite(parsed)) {
      this.nowIso = new Date(parsed).toISOString();
      this.nowEpoch = Math.floor(parsed / 1000);
    } else {
      this.nowIso = '2025-01-01T00:00:00.000Z';
      this.nowEpoch = 1_735_689_600;
    }
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(this.viewerLogin, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewerLogin,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      branchFiles: new Map(),
      issues: new Map(),
      prs: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: this.nowIso,
      version: 0,
      parents: new Map(),
      depth: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  // A repository belongs to the token's login; the same name under any other
  // owner reads as missing, never as forbidden.
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewerLogin) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewerLogin) return false;
    return this.repos.delete(this.key(owner, name));
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const { oid, obj } = makeObject(type, data);
    repo.objects.set(oid, obj);
    repo.version += 1;
    if (type === 'commit') repo.depth.clear();
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
    if (ref.startsWith('refs/heads/')) this.refreshBranchFiles(repo, ref.slice('refs/heads/'.length));
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.version += 1;
    if (ref.startsWith('refs/heads/')) repo.branchFiles.delete(ref.slice('refs/heads/'.length));
  }

  // Rebuild a branch's path -> blob map from its tip commit's tree.
  refreshBranchFiles(repo: Repo, branch: string): void {
    const tip = this.branchTip(repo, branch);
    const files = new Map<string, string>();
    if (tip !== undefined) {
      const commit = this.getObject(repo, tip);
      if (commit !== undefined && commit.type === 'commit') {
        this.walkTree(repo, parseCommit(commit.data).tree, '', files);
      }
    }
    repo.branchFiles.set(branch, files);
  }

  walkTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
    const tree = this.getObject(repo, treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.walkTree(repo, entry.oid, path, out);
      else out.set(path, entry.oid);
    }
  }

  branchFiles(repo: Repo, branch: string): Map<string, string> {
    let files = repo.branchFiles.get(branch);
    if (files === undefined) {
      this.refreshBranchFiles(repo, branch);
      files = repo.branchFiles.get(branch) as Map<string, string>;
    }
    return files;
  }

  // Build the tree objects for a flat path -> blob map, creating every
  // intermediate directory tree on the way.
  buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, string>>();
      for (const [path, oid] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: '100644', name: rest, oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, oid);
        }
      }
      for (const [dir, sub] of dirs) {
        const subPrefix = prefix === '' ? `${dir}/` : `${prefix}${dir}/`;
        void sub;
        entries.push({ mode: '40000', name: dir, oid: build(subPrefix) });
      }
      return this.putObject(repo, 'tree', buildTree(sortTreeEntries(entries)));
    };
    return build('');
  }

  createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      author: `${IDENTITY} ${this.nowEpoch} +0000`,
      committer: `${IDENTITY} ${this.nowEpoch} +0000`,
      message,
    });
    return this.putObject(repo, 'commit', data);
  }

  // Parents of a commit, parsed once. A missing or non-commit object has
  // no parents; that answer is not cached, since the object may land later.
  commitParents(repo: Repo, oid: string): string[] {
    const cached = repo.parents.get(oid);
    if (cached !== undefined) return cached;
    const obj = this.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') return [];
    const parents = parseCommit(obj.data).parents;
    repo.parents.set(oid, parents);
    return parents;
  }

  // Generation number: a root commit is 0, a child is one past its deepest
  // parent. Memoized per commit; the cache is dropped whenever a commit
  // lands, so a parent arriving after its child is still counted.
  commitDepth(repo: Repo, oid: string): number {
    const cached = repo.depth.get(oid);
    if (cached !== undefined) return cached;
    let depth = 0;
    for (const parent of this.commitParents(repo, oid)) {
      depth = Math.max(depth, this.commitDepth(repo, parent) + 1);
    }
    repo.depth.set(oid, depth);
    return depth;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const ancDepth = this.commitDepth(repo, anc);
    const seen = new Set<string>();
    const queue = [desc];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === anc) return true;
      // Ancestors only get shallower, so a commit at or below the
      // ancestor's depth cannot lead to it.
      if (this.commitDepth(repo, oid) <= ancDepth) continue;
      queue.push(...this.commitParents(repo, oid));
    }
    return false;
  }

  // The first commit reachable from both tips, found by walking both
  // histories newest-first. Undefined when the histories never meet.
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      queueA.push(...this.commitParents(repo, oid));
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.pop() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      queueB.push(...this.commitParents(repo, oid));
    }
    return undefined;
  }
}

// --- contents, branches, commits --------------------------------------------

export type PutContentResult =
  | { ok: true; status: 201 | 200; contentSha: string; commitSha: string }
  | { ok: false; error: 'stale' | 'repo-empty' };

export type GetContentResult =
  | { ok: true; kind: 'file'; sha: string; size: number; content: Buffer }
  | { ok: true; kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
  | { ok: false; error: 'not-found' };

export class ContentOps {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string,
    sha?: string,
  ): PutContentResult {
    const files = new Map(this.store.branchFiles(repo, branch));
    const existing = files.get(path);
    if (existing !== undefined && sha !== undefined && sha.toLowerCase() !== existing.toLowerCase()) {
      return { ok: false, error: 'stale' };
    }
    const blobOid = this.store.putObject(repo, 'blob', content);
    const isCreate = existing === undefined;
    files.set(path, blobOid);
    const treeOid = this.store.buildTreeFromFiles(repo, files);
    const tip = this.store.branchTip(repo, branch);
    const commitSha = this.store.createCommit(repo, treeOid, tip === undefined ? [] : [tip], message);
    this.store.setRef(repo, `refs/heads/${branch}`, commitSha);
    return { ok: true, status: isCreate ? 201 : 200, contentSha: blobOid, commitSha };
  }

  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string,
    sha?: string,
  ): { ok: true; commitSha: string } | { ok: false; error: 'not-found' | 'stale' } {
    const files = new Map(this.store.branchFiles(repo, branch));
    const existing = files.get(path);
    if (existing === undefined) return { ok: false, error: 'not-found' };
    if (sha !== undefined && sha.toLowerCase() !== existing.toLowerCase()) return { ok: false, error: 'stale' };
    files.delete(path);
    const treeOid = this.store.buildTreeFromFiles(repo, files);
    const tip = this.store.branchTip(repo, branch);
    const commitSha = this.store.createCommit(repo, treeOid, tip === undefined ? [] : [tip], message);
    this.store.setRef(repo, `refs/heads/${branch}`, commitSha);
    return { ok: true, commitSha };
  }

  getContent(repo: Repo, path: string, ref?: string): GetContentResult {
    const branch = ref ?? repo.defaultBranch;
    const files = this.store.branchFiles(repo, branch);
    const blobOid = files.get(path);
    if (blobOid !== undefined) {
      const blob = this.store.getObject(repo, blobOid);
      if (blob === undefined) return { ok: false, error: 'not-found' };
      return { ok: true, kind: 'file', sha: blobOid, size: blob.data.length, content: blob.data };
    }
    // A directory lists its immediate children; anything else is missing.
    const prefix = path === '' ? '' : `${path}/`;
    const entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] = [];
    const seenDirs = new Map<string, Map<string, string>>();
    for (const [filePath, oid] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ type: 'file', name: rest, path: filePath, sha: oid });
      } else {
        const dir = rest.slice(0, slash);
        let sub = seenDirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          seenDirs.set(dir, sub);
        }
        sub.set(filePath, oid);
      }
    }
    if (entries.length === 0 && seenDirs.size === 0) return { ok: false, error: 'not-found' };
    for (const [dir, sub] of seenDirs) {
      // The subtree hash is built from paths relative to the directory.
      const relative = new Map<string, string>();
      for (const [filePath, oid] of sub) relative.set(filePath.slice(prefix.length), oid);
      entries.push({ type: 'dir', name: dir, path: prefix + dir, sha: this.store.buildTreeFromFiles(repo, relative) });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, kind: 'dir', entries };
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // Newest first, following every parent, from the branch tip (or the
  // default branch when none is named).
  listCommits(repo: Repo, branch?: string): { sha: string; message: string }[] {
    const tip = branch === undefined ? this.store.branchTip(repo, repo.defaultBranch) : this.store.branchTip(repo, branch);
    if (tip === undefined) return [];
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.store.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parts = parseCommit(obj.data);
      out.push({ sha: oid, message: parts.message });
      queue.push(...parts.parents);
    }
    return out;
  }
}

// --- issues, labels, comments ------------------------------------------------

export class IssueOps {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labels: string[],
  ): { ok: true; issue: Issue } | { ok: false; badLabel: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { ok: false, badLabel: name };
    }
    const issue: Issue = {
      id: this.store.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: labels.slice(),
      user: this.store.viewerLogin,
      createdAt: this.store.nowIso,
      updatedAt: this.store.nowIso,
      seq: repo.nextNumber,
      comments: [],
    };
    this.store.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { ok: true, issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(repo: Repo, state: 'open' | 'closed' | 'all', direction: 'asc' | 'desc'): Issue[] {
    const all = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
    all.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return all;
  }

  patchIssue(repo: Repo, number: number, updates: { state?: 'open' | 'closed'; title?: string; body?: string }): Issue | undefined {
    const issue = repo.issues.get(number);
    if (issue === undefined) return undefined;
    if (updates.state !== undefined) issue.state = updates.state;
    if (updates.title !== undefined) issue.title = updates.title;
    if (updates.body !== undefined) issue.body = updates.body;
    issue.updatedAt = this.store.nowIso;
    return issue;
  }

  createComment(repo: Repo, number: number, body: string): Comment | undefined {
    const issue = repo.issues.get(number);
    if (issue === undefined) return undefined;
    const comment: Comment = {
      id: repo.nextCommentId,
      body,
      user: this.store.viewerLogin,
      createdAt: this.store.nowIso,
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }
}

// --- pull requests ------------------------------------------------------------

export class PullOps {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  createPr(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): { ok: true; pr: PullRequest } | { ok: false; error: 'bad-head' | 'bad-base' } {
    const headSha = this.store.branchTip(repo, head);
    if (headSha === undefined) return { ok: false, error: 'bad-head' };
    const baseSha = this.store.branchTip(repo, base);
    if (baseSha === undefined) return { ok: false, error: 'bad-base' };
    const pr: PullRequest = {
      id: this.store.nextPrId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      seq: repo.nextNumber,
      createdAt: this.store.nowIso,
    };
    this.store.nextPrId += 1;
    repo.nextNumber += 1;
    repo.prs.set(pr.number, pr);
    return { ok: true, pr };
  }

  getPr(repo: Repo, number: number): PullRequest | undefined {
    return repo.prs.get(number);
  }

  listPrs(repo: Repo, state: 'open' | 'closed' | 'all'): PullRequest[] {
    const all = [...repo.prs.values()].filter((pr) => state === 'all' || pr.state === state);
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  // The files a pull request changes, base tip against head tip.
  prFiles(repo: Repo, pr: PullRequest): FileChange[] {
    const baseTip = this.store.branchTip(repo, pr.base.ref);
    const headTip = this.store.branchTip(repo, pr.head.ref);
    if (baseTip === undefined || headTip === undefined) return [];
    return this.diffTips(repo, baseTip, headTip);
  }

  diffTips(repo: Repo, baseTip: string, headTip: string): FileChange[] {
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const baseCommit = this.store.getObject(repo, baseTip);
    const headCommit = this.store.getObject(repo, headTip);
    if (baseCommit !== undefined && baseCommit.type === 'commit') {
      this.store.walkTree(repo, parseCommit(baseCommit.data).tree, '', baseFiles);
    }
    if (headCommit !== undefined && headCommit.type === 'commit') {
      this.store.walkTree(repo, parseCommit(headCommit.data).tree, '', headFiles);
    }
    const out: FileChange[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const baseOid = baseFiles.get(path);
      const headOid = headFiles.get(path);
      if (baseOid === headOid) continue;
      if (baseOid === undefined && headOid !== undefined) {
        const blob = this.store.getObject(repo, headOid);
        const lines = blob === undefined ? 0 : countLines(blob.data.toString('utf8')).length;
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0 });
      } else if (baseOid !== undefined && headOid === undefined) {
        const blob = this.store.getObject(repo, baseOid);
        const lines = blob === undefined ? 0 : countLines(blob.data.toString('utf8')).length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines });
      } else if (baseOid !== undefined && headOid !== undefined) {
        const oldBlob = this.store.getObject(repo, baseOid);
        const newBlob = this.store.getObject(repo, headOid);
        const diff = lineDiff(
          oldBlob === undefined ? '' : oldBlob.data.toString('utf8'),
          newBlob === undefined ? '' : newBlob.data.toString('utf8'),
        );
        out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions });
      }
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  // A merge conflicts when the head and the base tip both changed the same
  // file after their common ancestor, and changed it differently.
  mergeConflicts(repo: Repo, pr: PullRequest): boolean {
    const baseTip = this.store.branchTip(repo, pr.base.ref);
    const headTip = this.store.branchTip(repo, pr.head.ref);
    if (baseTip === undefined || headTip === undefined) return true;
    const base = this.store.mergeBase(repo, baseTip, headTip);
    if (base === undefined) return false;
    const baseFiles = new Map<string, string>();
    const baseCommit = this.store.getObject(repo, base);
    if (baseCommit !== undefined && baseCommit.type === 'commit') {
      this.store.walkTree(repo, parseCommit(baseCommit.data).tree, '', baseFiles);
    }
    const headFiles = new Map<string, string>();
    const headCommit = this.store.getObject(repo, headTip);
    if (headCommit !== undefined && headCommit.type === 'commit') {
      this.store.walkTree(repo, parseCommit(headCommit.data).tree, '', headFiles);
    }
    const baseTipFiles = new Map<string, string>();
    const baseTipCommit = this.store.getObject(repo, baseTip);
    if (baseTipCommit !== undefined && baseTipCommit.type === 'commit') {
      this.store.walkTree(repo, parseCommit(baseTipCommit.data).tree, '', baseTipFiles);
    }
    const paths = new Set([...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const ancestor = baseFiles.get(path);
      const head = headFiles.get(path);
      const tip = baseTipFiles.get(path);
      const headChanged = head !== ancestor;
      const tipChanged = tip !== ancestor;
      if (headChanged && tipChanged && head !== tip) return true;
    }
    return false;
  }

  mergePr(
    repo: Repo,
    number: number,
  ): { ok: true; sha: string } | { ok: false; error: 'not-found' | 'closed' | 'conflict' } {
    const pr = repo.prs.get(number);
    if (pr === undefined) return { ok: false, error: 'not-found' };
    if (pr.state !== 'open') return { ok: false, error: 'closed' };
    if (this.mergeConflicts(repo, pr)) return { ok: false, error: 'conflict' };
    const headTip = this.store.branchTip(repo, pr.head.ref) as string;
    const baseTip = this.store.branchTip(repo, pr.base.ref) as string;
    const headCommit = this.store.getObject(repo, headTip);
    if (headCommit === undefined || headCommit.type !== 'commit') return { ok: false, error: 'conflict' };
    const tree = parseCommit(headCommit.data).tree;
    const sha = this.store.createCommit(
      repo,
      tree,
      [baseTip],
      `Merge pull request #${pr.number} from ${repo.owner}/${pr.head.ref}`,
    );
    this.store.setRef(repo, `refs/heads/${pr.base.ref}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.store.nowIso;
    pr.mergeCommitSha = sha;
    return { ok: true, sha };
  }
}
