// PoC for audit finding #1 + Codex review rounds 1-2:
// squash merge must preserve base-side changes, entry modes, combine an
// independent chmod with a content edit, and reject file/directory
// collisions — with ONE resolver for conflict detection and tree building.
// Run: node poc-merge.mjs  (Node 24 type-stripping)
import { Store, PullOps } from './store.ts';
import { parseCommit } from './gitobj.ts';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function freshRepo() {
  const store = new Store(undefined);
  const pulls = new PullOps(store);
  const repo = store.createRepo('poc', 'poc', false);
  return { store, pulls, repo };
}

// files: [path, content, mode?]; modes default to 100644.
function commitFiles(store, repo, branch, files, message) {
  const entries = new Map();
  for (const [path, content, mode] of files) {
    entries.set(path, { oid: store.putObject(repo, 'blob', Buffer.from(content)), mode: mode ?? '100644' });
  }
  const tree = store.buildTreeFromEntries(repo, entries);
  const tip = store.branchTip(repo, branch);
  const sha = store.createCommit(repo, tree, tip ? [tip] : [], message);
  store.setRef(repo, `refs/heads/${branch}`, sha);
  return sha;
}

function mergedEntries(store, repo, sha) {
  const commit = store.getObject(repo, sha);
  const out = new Map();
  store.walkTreeEntries(repo, parseCommit(commit.data).tree, '', out);
  return out;
}

// Standard fixture: main and feature both branch off C0 (README + run.sh).
function scenario(baseFiles, headFiles) {
  const { store, pulls, repo } = freshRepo();
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['run.sh', '#!/bin/sh']], 'init');
  store.setRef(repo, 'refs/heads/feature', store.branchTip(repo, 'main'));
  commitFiles(store, repo, 'main', baseFiles, 'base');
  commitFiles(store, repo, 'feature', headFiles, 'head');
  const created = pulls.createPr(repo, 't', '', 'feature', 'main');
  return { store, pulls, repo, pr: created.pr };
}

// --- Case 1: base-only + head-only files both survive (the audit's bug) ---
{
  const { store, pulls, repo } = freshRepo();
  commitFiles(store, repo, 'main', [['README.md', 'hi']], 'init');
  store.setRef(repo, 'refs/heads/feature', store.branchTip(repo, 'main'));
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['base-only.txt', 'base']], 'base adds file');
  commitFiles(store, repo, 'feature', [['README.md', 'hi'], ['head-only.txt', 'head']], 'head adds file');
  const created = pulls.createPr(repo, 't', '', 'feature', 'main');
  const res = pulls.mergePr(repo, created.pr.number);
  const files = res.ok ? mergedEntries(store, repo, res.sha) : new Map();
  check('case 1: base-only.txt survives', files.has('base-only.txt'));
  check('case 1: head-only.txt survives', files.has('head-only.txt'));
}

// --- Case 2: head chmods a file 100644 -> 100755; the mode must survive ---
{
  const { store, pulls, repo, pr } = scenario(
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh'], ['base-only.txt', 'base']],
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh', '100755']],
  );
  const res = pulls.mergePr(repo, pr.number);
  const files = res.ok ? mergedEntries(store, repo, res.sha) : new Map();
  check('case 2: merge succeeds', res.ok, res.ok ? '' : res.error);
  check('case 2: run.sh keeps mode 100755', files.get('run.sh')?.mode === '100755', `got ${files.get('run.sh')?.mode}`);
  check('case 2: base-only.txt survives', files.has('base-only.txt'));
}

// --- Case 3: base adds `doc` as a file, head adds `doc/index` -> conflict ---
{
  const { store, pulls, repo, pr } = scenario(
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh'], ['doc', 'file']],
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh'], ['doc/index', 'page']],
  );
  const res = pulls.mergePr(repo, pr.number);
  check('case 3: file/dir collision is a conflict', !res.ok && res.error === 'conflict', `got ${JSON.stringify(res)}`);
  check('case 3: mergeConflicts agrees (GraphQL mergeable)', pulls.mergeConflicts(repo, pr) === true);
}

// --- Case 4: head chmods, base edits content -> combine (base content + head mode) ---
{
  const { store, pulls, repo, pr } = scenario(
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh v2']],
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh', '100755']],
  );
  const res = pulls.mergePr(repo, pr.number);
  const files = res.ok ? mergedEntries(store, repo, res.sha) : new Map();
  check('case 4: merge succeeds', res.ok, res.ok ? '' : res.error);
  const blob = res.ok ? store.getObject(repo, files.get('run.sh').oid) : undefined;
  check('case 4: run.sh has base content + head mode',
    blob?.data.toString() === '#!/bin/sh v2' && files.get('run.sh')?.mode === '100755',
    `content=${JSON.stringify(blob?.data.toString())} mode=${files.get('run.sh')?.mode}`);
}

// --- Case 5: head edits content, base chmods -> combine (head content + base mode) ---
{
  const { store, pulls, repo, pr } = scenario(
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh', '100755']],
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh v2']],
  );
  const res = pulls.mergePr(repo, pr.number);
  const files = res.ok ? mergedEntries(store, repo, res.sha) : new Map();
  check('case 5: merge succeeds', res.ok, res.ok ? '' : res.error);
  const blob = res.ok ? store.getObject(repo, files.get('run.sh').oid) : undefined;
  check('case 5: run.sh has head content + base mode',
    blob?.data.toString() === '#!/bin/sh v2' && files.get('run.sh')?.mode === '100755',
    `content=${JSON.stringify(blob?.data.toString())} mode=${files.get('run.sh')?.mode}`);
}

// --- Case 6: both chmod differently, same blob -> conflict ---
{
  const { store, pulls, repo, pr } = scenario(
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh', '100755']],
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh', '120000']],
  );
  const res = pulls.mergePr(repo, pr.number);
  check('case 6: divergent mode changes conflict', !res.ok && res.error === 'conflict', `got ${JSON.stringify(res)}`);
}

// --- Case 7: chmod-versus-delete, both directions -> conflict ---
{
  const { store: s1, pulls: p1, repo: r1, pr: pr1 } = scenario(
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh', '100755']],
    [['README.md', 'hi']],
  );
  const res1 = p1.mergePr(r1, pr1.number);
  check('case 7a: base chmods, head deletes -> conflict', !res1.ok && res1.error === 'conflict', `got ${JSON.stringify(res1)}`);
  const { store: s2, pulls: p2, repo: r2, pr: pr2 } = scenario(
    [['README.md', 'hi']],
    [['README.md', 'hi'], ['run.sh', '#!/bin/sh', '100755']],
  );
  const res2 = p2.mergePr(r2, pr2.number);
  check('case 7b: base deletes, head chmods -> conflict', !res2.ok && res2.error === 'conflict', `got ${JSON.stringify(res2)}`);
}

// --- Case 8: file->symlink conversion vs regular edit -> conflict ---
// (A symlink to "old-target" has the same blob as a regular file containing
// "old-target"; combining it with a content edit would fabricate a symlink
// pointing at bytes neither side chose.)
{
  const { store, pulls, repo } = freshRepo();
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['run.sh', 'old-target']], 'init');
  store.setRef(repo, 'refs/heads/feature', store.branchTip(repo, 'main'));
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['run.sh', 'new-regular-bytes']], 'base edits file');
  commitFiles(store, repo, 'feature', [['README.md', 'hi'], ['run.sh', 'old-target', '120000']], 'head converts to symlink');
  const created = pulls.createPr(repo, 't', '', 'feature', 'main');
  const res = pulls.mergePr(repo, created.pr.number);
  check('case 8: file->symlink vs regular edit conflicts', !res.ok && res.error === 'conflict', `got ${JSON.stringify(res)}`);
}

// --- Case 9 (reverse): symlink retarget vs symlink->file conversion -> conflict ---
{
  const { store, pulls, repo } = freshRepo();
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['run.sh', 'old-target', '120000']], 'init');
  store.setRef(repo, 'refs/heads/feature', store.branchTip(repo, 'main'));
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['run.sh', 'old-target', '100644']], 'base converts to file');
  commitFiles(store, repo, 'feature', [['README.md', 'hi'], ['run.sh', 'new-target', '120000']], 'head retargets symlink');
  const created = pulls.createPr(repo, 't', '', 'feature', 'main');
  const res = pulls.mergePr(repo, created.pr.number);
  check('case 9: symlink retarget vs symlink->file conflicts', !res.ok && res.error === 'conflict', `got ${JSON.stringify(res)}`);
}

// --- Case 10: symlink conversion on one side only -> merges, symlink kept ---
{
  const { store, pulls, repo } = freshRepo();
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['run.sh', 'old-target']], 'init');
  store.setRef(repo, 'refs/heads/feature', store.branchTip(repo, 'main'));
  commitFiles(store, repo, 'main', [['README.md', 'hi'], ['run.sh', 'old-target'], ['base-only.txt', 'base']], 'base adds file');
  commitFiles(store, repo, 'feature', [['README.md', 'hi'], ['run.sh', 'old-target', '120000']], 'head converts to symlink');
  const created = pulls.createPr(repo, 't', '', 'feature', 'main');
  const res = pulls.mergePr(repo, created.pr.number);
  const files = res.ok ? mergedEntries(store, repo, res.sha) : new Map();
  check('case 10: one-sided symlink conversion merges', res.ok, res.ok ? '' : res.error);
  check('case 10: run.sh is a symlink', files.get('run.sh')?.mode === '120000', `got ${files.get('run.sh')?.mode}`);
  check('case 10: base-only.txt survives', files.has('base-only.txt'));
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
