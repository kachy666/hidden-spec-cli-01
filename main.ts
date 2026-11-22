// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileData {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileData {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(fd: FileData): string {
  if (fd.lines.length === 0) return '';
  return fd.lines.join(fd.br) + (fd.final ? fd.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Positions at or after `from` where `old` matches `lines` at one tier (SPEC.md section 5). */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const eq =
    tier === 0 ? (a: string, b: string): boolean => a === b
    : tier === 1 ? (a: string, b: string): boolean => trimEndWs(a) === trimEndWs(b)
    : (a: string, b: string): boolean => trimBothWs(a) === trimBothWs(b);
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (!eq(lines[i + k]!, old[k]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(lines: string[], old: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, old, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/**
 * The lines that replace a matched occurrence. Context lines (oldIdx set) are the file's own matched lines;
 * added lines are written as they are, except at tier 2 they are re-indented (SPEC.md section 5).
 */
function buildReplacement(
  fileLines: string[],
  pos: number,
  old: string[],
  nlines: { text: string; oldIdx: number | null }[],
  tier: number,
): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(old[0] ?? '');
  const out: string[] = [];
  for (const nl of nlines) {
    if (nl.oldIdx !== null) {
      out.push(fileLines[pos + nl.oldIdx]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs (old path, new path) recorded by move edits, in order. */
  readonly moves: [string, string][] = [];
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** ---- Unified diffs (SPEC.md section 6) ---- */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const isHunkHeader = (l: string): boolean => HUNK_RE.test(l);

/** One hunk: its old start A, its old lines, its new lines (context lines carry their old index). */
interface Hunk {
  a: number;
  oldLines: string[];
  newLines: { text: string; oldIdx: number | null }[];
  /** A `\` line follows the hunk's last `+` line. */
  noEolAfterLastPlus: boolean;
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolAfterLastCtxOrPlus: boolean;
  /** The hunk has a context or `+` line. */
  hasCtxOrPlus: boolean;
}

interface SectionBuilder {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** A unified path after the four characters, up to the first tab, spaces removed; /dev/null is no file. */
function cleanUnifiedPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A section's header: paths, rename lines, file-mode lines; stops at a hunk, a new section, or the end. */
function parseUnifiedHeader(lines: string[], i: number, sec: SectionBuilder): number {
  let pairSet = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) {
      if (!isHunkHeader(l)) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx === undefined || !nx.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (pairSet) break;
      sec.pairOld = cleanUnifiedPath(l.slice(4));
      sec.pairNew = cleanUnifiedPath(nx.slice(4));
      pairSet = true;
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.renameFrom = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameTo = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l === 'new file mode' || l.startsWith('new file mode ')) {
      sec.creation = true;
      i++;
      continue;
    }
    if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
      sec.deletion = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/** One hunk header and body; returns the index after the body. */
function parseHunk(lines: string[], i: number, sec: SectionBuilder): number {
  const m = HUNK_RE.exec(lines[i]!);
  const a = parseInt(m![1]!, 10);
  i++;
  type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
  const body: BodyLine[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1) });
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  const oldLines: string[] = [];
  const newLines: { text: string; oldIdx: number | null }[] = [];
  let lastPlusIdx = -1;
  let lastCtxOrPlusIdx = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b.kind === 'ctx') {
      newLines.push({ text: b.text, oldIdx: oldLines.length });
      oldLines.push(b.text);
      lastCtxOrPlusIdx = k;
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else if (b.kind === 'new') {
      newLines.push({ text: b.text, oldIdx: null });
      lastPlusIdx = k;
      lastCtxOrPlusIdx = k;
    }
  }
  const followsBs = (idx: number): boolean => {
    const nx = body[idx + 1];
    return nx !== undefined && nx.kind === 'bs';
  };
  sec.hunks.push({
    a,
    oldLines,
    newLines,
    noEolAfterLastPlus: lastPlusIdx >= 0 && followsBs(lastPlusIdx),
    noEolAfterLastCtxOrPlus: lastCtxOrPlusIdx >= 0 && followsBs(lastCtxOrPlusIdx),
    hasCtxOrPlus: lastCtxOrPlusIdx >= 0,
  });
  return i;
}

/** A section's hunks; stops at a new section or the end. */
function parseUnifiedHunks(lines: string[], i: number, sec: SectionBuilder): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      if (!isHunkHeader(l)) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunk(lines, i, sec);
      continue;
    }
    i++;
  }
  return i;
}

/** A section's hunks applied in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const fd = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.min(h.a + d, fd.lines.length);
      const ins = h.newLines.map((nl) => nl.text);
      const atEnd = at === fd.lines.length;
      fd.lines.splice(at, 0, ...ins);
      if (atEnd && ins.length > 0) fd.final = !h.noEolAfterLastPlus;
      d += ins.length;
    } else {
      const found = findTier(fd.lines, h.oldLines, 0, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + h.oldLines.length === fd.lines.length;
      const repl = buildReplacement(fd.lines, best, h.oldLines, h.newLines, found.tier);
      fd.lines.splice(best, h.oldLines.length, ...repl);
      if (runsToEnd) {
        if (h.hasCtxOrPlus) fd.final = !h.noEolAfterLastCtxOrPlus;
        else fd.final = fd.lines.length > 0;
      }
      d += h.newLines.length - h.oldLines.length;
    }
  }
  return renderFile(fd);
}

/** One unified section as one edit (SPEC.md section 6). */
function sectionToEdit(sec: SectionBuilder, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const isCreation = oldP === null || sec.creation;
  const isDeletion = !isCreation && (newP === null || sec.deletion);
  if (isCreation) {
    const np = newP as string | null | undefined;
    if (np === null || np === undefined) return () => {};
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const nl of h.newLines) if (nl.oldIdx === null) plus.push(nl.text);
      }
      let noEol = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.newLines.some((nl) => nl.oldIdx === null)) {
          noEol = h.noEolAfterLastPlus;
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (isDeletion) {
    const op = oldP as string | null | undefined;
    if (op === null || op === undefined) return () => {};
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = oldP as string | undefined;
  const np = newP as string | undefined;
  if (op === undefined || np === undefined) return () => {};
  if (op !== np) {
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, sec.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.recordMove(op, np);
    };
  }
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(before, sec.hunks, strict, op));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: SectionBuilder[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: SectionBuilder = { diffOld: m[1], diffNew: m[2], creation: false, deletion: false, hunks: [] };
      i++;
      i = parseUnifiedHeader(lines, i, sec);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: SectionBuilder = { creation: false, deletion: false, hunks: [] };
      i = parseUnifiedHeader(lines, i, sec);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return sections.map((sec) => sectionToEdit(sec, strict));
}

/** ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function searchEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fd = parseFile(before);
    const found = findTier(fd.lines, oldLines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const repl = buildReplacement(fd.lines, pos, oldLines, newLines.map((t) => ({ text: t, oldIdx: null })), found.tier);
    fd.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, renderFile(fd));
  };
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si < 0) break;
    let nextSearch = -1;
    for (let j = si + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        nextSearch = j;
        break;
      }
    }
    const bound = nextSearch < 0 ? lines.length : nextSearch;
    let eq = -1;
    for (let j = si + 1; j < bound; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < bound; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    let path: string | null = null;
    for (let k = si - 1; k >= searchFrom; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchEdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** ---- V4A patches (SPEC.md section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: { text: string; oldIdx: number | null }[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, secLines: { text: string; num: number }[], updateNum: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to:')) {
    moveTo = secLines[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  let cur: { anchor: string | null; eof: boolean; body: { kind: 'ctx' | 'old' | 'new'; text: string }[] } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const oldLines: string[] = [];
    const newLines: { text: string; oldIdx: number | null }[] = [];
    for (const b of cur.body) {
      if (b.kind === 'ctx') {
        newLines.push({ text: b.text, oldIdx: oldLines.length });
        oldLines.push(b.text);
      } else if (b.kind === 'old') oldLines.push(b.text);
      else newLines.push({ text: b.text, oldIdx: null });
    }
    chunks.push({ anchor: cur.anchor, eof: cur.eof, oldLines, newLines });
    cur = null;
  };
  for (; idx < secLines.length; idx++) {
    const s = secLines[idx]!;
    const t = s.text;
    if (t.startsWith('@@')) {
      flush();
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) cur = { anchor: null, eof: false, body: [] };
      cur.eof = true;
      flush();
      continue;
    }
    if (t.startsWith('*** Move to:')) throw new Exit2(`error: parse ${s.num}`);
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) cur = { anchor: null, eof: false, body: [] };
      if (t === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (t.startsWith(' ')) cur.body.push({ kind: 'ctx', text: t.slice(1) });
      else if (t.startsWith('-')) cur.body.push({ kind: 'old', text: t.slice(1) });
      else cur.body.push({ kind: 'new', text: t.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${s.num}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const fd = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(fd.lines, [chunk.anchor], cursor, strict);
        if (!found) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      if (chunk.oldLines.length === 0) {
        const at = chunk.eof ? fd.lines.length : cursor;
        const ins = chunk.newLines.map((nl) => nl.text);
        fd.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findTier(fd.lines, chunk.oldLines, cursor, strict);
        if (!found) throw new Fail('no-match', path);
        let positions = found.positions;
        if (chunk.eof) positions = positions.filter((p) => p + chunk.oldLines.length === fd.lines.length);
        if (positions.length === 0) throw new Fail('no-match', path);
        const pos = positions[0]!;
        const repl = buildReplacement(fd.lines, pos, chunk.oldLines, chunk.newLines, found.tier);
        fd.lines.splice(pos, chunk.oldLines.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = renderFile(fd);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) {
      const kind = l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'delete' : 'update';
      const path = l.slice(l.indexOf(':') + 1).trim();
      const headNum = i + 1;
      const secLines: { text: string; num: number }[] = [];
      i++;
      while (i < last) {
        const sl = lines[i]!;
        if (sl.startsWith('*** Add File:') || sl.startsWith('*** Delete File:') || sl.startsWith('*** Update File:')) break;
        secLines.push({ text: sl, num: i + 1 });
        i++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const s of secLines) {
          if (s.text === '') fileLines.push('');
          else if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
          else throw new Exit2(`error: parse ${s.num}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (kind === 'delete') {
        if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.num}`);
        edits.push(v4aDeleteEdit(path));
      } else {
        edits.push(v4aUpdateEdit(path, secLines, headNum, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const dRows = new Map<string, string>();
  const aRows = new Map<string, string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) aRows.set(p, `A ${p}`);
    else if (now === null) dRows.set(p, `D ${p}`);
    else rows.push({ key: p, line: `M ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (dRows.has(oldP) && aRows.has(newP)) {
      dRows.delete(oldP);
      aRows.delete(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, line] of dRows) rows.push({ key: p, line });
  for (const [p, line] of aRows) rows.push({ key: p, line });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
