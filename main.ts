// main.ts is mend: one command-line tool that applies the edits AI models write, in four formats, to a tree of
// text files, as SPEC.md (version 1) specifies it. Node 22, the standard library alone.
//
// The shape of the program follows the specification: section 1 reads the command line, section 2 decides what is
// written and the exit code, section 3 owns files, lines and paths, section 4 detects the format, section 5 is the
// one line matcher every line-based format shares, and sections 6 to 9 each read one format into a list of edits.
// Section 10 applies that list to an in-memory tree and writes it only when every edit succeeded.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

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
const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leading = (s: string): string => /^[ \t]*/.exec(s)![0];

// Section 3: a patch's lines are its text split at \n, each with one trailing \r removed, and without the empty
// piece after a final \n.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// Section 3: a file's line break is CRLF when its first line feed follows a carriage return, LF otherwise.
function breakOf(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

/** A file's lines, its own line break, and whether it ends with that break (section 3). */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function decodeDoc(text: string): Doc {
  const br = breakOf(text);
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function encodeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as (old, new) pairs; section 2's R lines come from these. */
  readonly moves: { from: string; to: string }[] = [];

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

// ---------------------------------------------------------------------------------------------------------------
// Section 4: detecting the format.
// ---------------------------------------------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimEnd(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 5: matching lines, at three tiers.
// ---------------------------------------------------------------------------------------------------------------

const TIERS = [0, 1, 2];

function atTier(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEnd(line);
  return trimBoth(line);
}

/** Every 0-based position where `needle` occurs in `hay` at one tier; occurrences may overlap. */
function occurrences(hay: string[], needle: string[], tier: number): number[] {
  const out: number[] = [];
  const n = needle.length;
  if (n === 0 || n > hay.length) return out;
  const norm = tier === 0 ? (s: string): string => s : (s: string): string => atTier(s, tier);
  const first = norm(needle[0]!);
  const rest = needle.slice(1).map(norm);
  for (let i = 0; i + n <= hay.length; i++) {
    if (norm(hay[i]!) !== first) continue;
    let ok = true;
    for (let j = 1; j < n; j++) {
      if (norm(hay[i + j]!) !== rest[j - 1]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `needle` occurs at all, and its occurrences there. */
function findTier(hay: string[], needle: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const tier of strict ? [0] : TIERS) {
    const pos = occurrences(hay, needle, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

type Kind = 'context' | 'old' | 'new';

interface BodyLine {
  kind: Kind | 'marker';
  text: string;
  /** A unified body line that was empty in the patch: section 6 leaves trailing empty lines out of a body. */
  bare?: boolean;
}

/** The lines an edit replaces (O): its context and - lines, in body order. */
const oldSide = (body: BodyLine[]): string[] => body.filter((b) => b.kind === 'context' || b.kind === 'old').map((b) => b.text);
/** The lines an edit writes (N): its context and + lines, in body order. */
const newSide = (body: BodyLine[]): BodyLine[] => body.filter((b) => b.kind === 'context' || b.kind === 'new');

/**
 * Section 5: N replaces the k matched lines. A context line is written as the file's own matched line. At tier 2
 * every other (non-context) line of N is re-indented: P, the leading spaces and tabs of O's first line, becomes F,
 * the leading spaces and tabs of the file's first matched line.
 */
function replacement(body: BodyLine[], matched: string[], tier: number): string[] {
  const oFirst = body.find((b) => b.kind === 'context' || b.kind === 'old');
  const P = oFirst === undefined ? '' : leading(oFirst.text);
  const F = matched.length > 0 ? leading(matched[0]!) : '';
  const out: string[] = [];
  let m = 0;
  for (const b of body) {
    if (b.kind === 'context') {
      out.push(matched[m] ?? b.text);
      m += 1;
    } else if (b.kind === 'old') {
      m += 1;
    } else if (b.kind === 'new') {
      let t = b.text;
      if (tier === 2 && t !== '' && t.trim() !== '') {
        if (P === '') t = F + t;
        else if (t.startsWith(P)) t = F + t.slice(P.length);
      }
      out.push(t);
    }
  }
  return out;
}

/** True when a `\` line follows the body's last context or + line (section 6's no-newline marker). */
function noNewlineMarker(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const k = body[i]!.kind;
    if (k === 'context' || k === 'new') last = i;
  }
  return last >= 0 && body[last + 1]?.kind === 'marker';
}

/** True when a `\` line follows the body's last + line (a created file's no-newline marker). */
function noNewlineAfterLastAdd(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.kind === 'new') last = i;
  return last >= 0 && body[last + 1]?.kind === 'marker';
}

// ---------------------------------------------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  line: number;
  oldP: string | null | undefined;
  newP: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

/** Section 6: the path of a `--- ` or `+++ ` line, `/dev/null` as null, and a leading a/ or b/ removed. */
function headerPath(line: string): string | null {
  const text = line.slice(4).split('\t')[0]!.trim();
  if (text === '/dev/null') return null;
  if (text.startsWith('a/') || text.startsWith('b/')) return text.slice(2);
  return text;
}

function parseGitLine(line: string, n: number): { old: string; now: string } {
  const rest = line.slice('diff --git '.length);
  const idx = rest.lastIndexOf(' b/');
  if (!rest.startsWith('a/') || idx < 2) throw new Exit2(`error: parse ${n}`);
  const old = rest.slice(2, idx);
  const now = rest.slice(idx + 3);
  if (old === '' || now === '') throw new Exit2(`error: parse ${n}`);
  return { old, now };
}

function newSection(line: number): USection {
  return { line, oldP: undefined, newP: undefined, renameFrom: undefined, renameTo: undefined, gitOld: undefined, gitNew: undefined, create: false, del: false, hunks: [] };
}

function headerLine(sec: USection, line: string): void {
  if (line.startsWith('--- ')) sec.oldP = headerPath(line);
  else if (line.startsWith('+++ ')) sec.newP = headerPath(line);
  else if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length);
  else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length);
  else if (line.startsWith('new file mode')) sec.create = true;
  else if (line.startsWith('deleted file mode')) sec.del = true;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseGitLine(line, i + 1);
      cur = newSection(i + 1);
      cur.gitOld = g.old;
      cur.gitNew = g.now;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || (cur as USection).hunks.length > 0) {
        cur = newSection(i + 1);
        sections.push(cur);
      }
      headerLine(cur as USection, line);
      headerLine(cur as USection, lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ kind: 'context', text: '', bare: true });
        else if (b[0] === ' ') body.push({ kind: 'context', text: b.slice(1) });
        else if (b[0] === '-') body.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') body.push({ kind: 'new', text: b.slice(1) });
        else if (b[0] === '\\') body.push({ kind: 'marker', text: b });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.bare === true) body.pop();
      (cur as USection).hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null) {
      const sec = cur as USection;
      if (sec.hunks.length === 0) {
        if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
        headerLine(sec, line);
      }
    }
    i += 1;
  }

  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.oldP !== undefined ? sec.oldP : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.newP !== undefined ? sec.newP : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const create = oldPath === null || sec.create;
  const del = newPath === null || sec.del;

  return (tree) => {
    if (create) {
      if (oldPath !== null && oldPath !== undefined && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') added.push(b.text);
      // The marker refers to the last + line of the whole section: only the last hunk that has one decides.
      let noEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        if (body.some((b) => b.kind === 'new')) {
          noEol = noNewlineAfterLastAdd(body);
          break;
        }
      }
      const doc: Doc = { lines: added, br: '\n', final: !noEol };
      tree.now.set(p, encodeDoc(doc));
      return;
    }

    if (del) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }

    const from = oldPath ?? '';
    const to = newPath ?? from;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const after = applyUnifiedHunks(decodeDoc(before), sec.hunks, strict, from);
    tree.now.set(from, null);
    tree.now.set(to, encodeDoc(after));
    if (to !== from) tree.moves.push({ from, to });
  };
}

function applyUnifiedHunks(doc: Doc, hunks: UHunk[], strict: boolean, path: string): Doc {
  let lines = doc.lines.slice();
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const O = oldSide(h.body);
    const N = newSide(h.body);
    let pos: number;
    let tier = 0;
    if (O.length === 0) {
      pos = Math.max(0, Math.min(h.a + d, lines.length));
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let dist = Math.abs(best - target);
      for (const p of found.pos) {
        const dp = Math.abs(p - target);
        if (dp < dist) {
          best = p;
          dist = dp;
        }
      }
      pos = best;
    }
    const matched = lines.slice(pos, pos + O.length);
    const repl = replacement(h.body, matched, tier);
    const reachesEnd = O.length === 0 ? pos === lines.length : pos + O.length === lines.length;
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
    if (reachesEnd) final = !noNewlineMarker(h.body);
    d += N.length - O.length;
  }
  return { lines, br: doc.br, final };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------------------------------------------

const SEARCH_MARK = '<<<<<<< SEARCH';
const DIVIDER_MARK = '=======';
const REPLACE_MARK = '>>>>>>> REPLACE';

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (trimEnd(lines[i]!) !== SEARCH_MARK) {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path = prevPath;
    for (let k = i - 1; k > prevEnd; k--) {
      const text = lines[k]!;
      if (blank(text)) continue;
      const trimmed = text.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === undefined) throw new Exit2(`error: parse ${searchLine + 1}`);
    // The block's markers come in order: SEARCH, =======, REPLACE. A REPLACE before any ======= means the pair
    // the SEARCH line needs is not there (section 7).
    let divider = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = trimEnd(lines[k]!);
      if (t === DIVIDER_MARK) {
        divider = k;
        break;
      }
      if (t === REPLACE_MARK) break;
    }
    if (divider < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = divider + 1; k < lines.length; k++) {
      if (trimEnd(lines[k]!) === REPLACE_MARK) {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(i + 1, divider), lines.slice(divider + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, encodeDoc({ lines: newLines.slice(), br: '\n', final: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = decodeDoc(before);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const body: BodyLine[] = [
      ...oldLines.map((text) => ({ kind: 'old' as Kind, text })),
      ...newLines.map((text) => ({ kind: 'new' as Kind, text })),
    ];
    const repl = replacement(body, doc.lines.slice(pos, pos + oldLines.length), found.tier);
    const lines = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, encodeDoc({ lines, br: doc.br, final: doc.final }));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  line: number;
  path: string;
  moveTo: string | undefined;
  content: string[];
  chunks: VChunk[];
}

const ADD_HEAD = '*** Add File: ';
const DELETE_HEAD = '*** Delete File: ';
const UPDATE_HEAD = '*** Update File: ';
const MOVE_HEAD = '*** Move to: ';
const EOF_MARK = '*** End of File';

function isSectionHead(line: string): boolean {
  return line.startsWith(ADD_HEAD) || line.startsWith(DELETE_HEAD) || line.startsWith(UPDATE_HEAD);
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let sec: VSection;
    if (line.startsWith(ADD_HEAD)) sec = { kind: 'add', line: i + 1, path: line.slice(ADD_HEAD.length).trim(), moveTo: undefined, content: [], chunks: [] };
    else if (line.startsWith(DELETE_HEAD)) sec = { kind: 'delete', line: i + 1, path: line.slice(DELETE_HEAD.length).trim(), moveTo: undefined, content: [], chunks: [] };
    else if (line.startsWith(UPDATE_HEAD)) sec = { kind: 'update', line: i + 1, path: line.slice(UPDATE_HEAD.length).trim(), moveTo: undefined, content: [], chunks: [] };
    else throw new Exit2(`error: parse ${i + 1}`);

    let j = i + 1;
    while (j < last && !isSectionHead(lines[j]!)) j += 1;
    const seg: { text: string; line: number }[] = [];
    for (let k = i + 1; k < j; k++) seg.push({ text: lines[k]!, line: k + 1 });
    while (seg.length > 0 && blank(seg[seg.length - 1]!.text)) seg.pop();
    sections.push(sec);

    if (sec.kind === 'add') {
      for (const s of seg) {
        if (s.text === '') sec.content.push('');
        else if (s.text[0] === '+') sec.content.push(s.text.slice(1));
        else throw new Exit2(`error: parse ${s.line}`);
      }
    } else if (sec.kind === 'delete') {
      if (seg.length > 0) throw new Exit2(`error: parse ${seg[0]!.line}`);
    } else {
      parseV4AUpdate(sec, seg);
    }
    i = j;
  }
  return sections.map((sec) => v4aEdit(sec, strict));
}

function parseV4AUpdate(sec: VSection, seg: { text: string; line: number }[]): void {
  let k = 0;
  if (seg.length > 0 && seg[0]!.text.startsWith(MOVE_HEAD)) {
    sec.moveTo = seg[0]!.text.slice(MOVE_HEAD.length).trim();
    k = 1;
  }
  let cur: VChunk | null = null;
  for (; k < seg.length; k++) {
    const { text, line } = seg[k]!;
    if (text.startsWith('@@')) {
      if (cur !== null) sec.chunks.push(cur);
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      continue;
    }
    if (trimEnd(text) === EOF_MARK) {
      if (cur === null) throw new Exit2(`error: parse ${line}`);
      cur.eof = true;
      sec.chunks.push(cur);
      cur = null;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${line}`);
        cur = { anchor: null, body: [], eof: false };
      }
      const kind: Kind | 'marker' = text === '' ? 'context' : text[0] === ' ' ? 'context' : text[0] === '-' ? 'old' : 'new';
      cur.body.push({ kind, text: text === '' ? '' : text.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${line}`);
  }
  if (cur !== null) sec.chunks.push(cur);
  if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.line}`);
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (sec.kind === 'add') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.content.length === 0 ? '' : `${sec.content.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const after = applyChunks(decodeDoc(before), sec.chunks, p, strict);
    tree.now.set(p, null);
    const to = sec.moveTo ?? p;
    tree.now.set(to, encodeDoc(after));
    if (to !== p) tree.moves.push({ from: p, to });
  };
}

function applyChunks(doc: Doc, chunks: VChunk[], path: string, strict: boolean): Doc {
  const tiers = strict ? [0] : TIERS;
  let lines = doc.lines.slice();
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let hit = -1;
      for (const tier of tiers) {
        for (let i = cursor; i < lines.length; i++) {
          if (atTier(lines[i]!, tier) === atTier(ch.anchor, tier)) {
            hit = i;
            break;
          }
        }
        if (hit >= 0) break;
      }
      if (hit < 0) throw new Fail('no-match', path);
      cursor = hit + 1;
    }
    const O = oldSide(ch.body);
    let tier = 0;
    let pos: number;
    if (O.length === 0) {
      pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
    } else {
      let found = false;
      pos = -1;
      for (const t of tiers) {
        for (let i = cursor; i + O.length <= lines.length; i++) {
          if (ch.eof && i + O.length !== lines.length) continue;
          let ok = true;
          for (let j = 0; j < O.length; j++) {
            if (atTier(lines[i + j]!, t) !== atTier(O[j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            tier = t;
            pos = i;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) throw new Fail('no-match', path);
    }
    const matched = lines.slice(pos, pos + O.length);
    const repl = replacement(ch.body, matched, tier);
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
    cursor = pos + repl.length;
  }
  return { lines, br: doc.br, final: doc.final };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const ifSafe = (): void => {
    if (!safe(p)) throw new Fail('unsafe', p);
  };
  const existing = (tree: Tree): string => {
    ifSafe();
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      ifSafe();
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const crlf = breakOf(before) === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + lf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const doc = decodeDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = doc.lines.slice();
      lines.splice(line, 0, ...add);
      tree.now.set(p, encodeDoc({ lines, br: doc.br, final: doc.final }));
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

// ---------------------------------------------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, and the all-or-nothing write.
// ---------------------------------------------------------------------------------------------------------------

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
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4A(lines, strict);
    else edits = jsonEdits(text, lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const moves = tree.moves.filter((m) => {
    const oldWas = tree.original(m.from);
    const oldNow = tree.get(m.from);
    const newWas = tree.original(m.to);
    const newNow = tree.get(m.to);
    return oldWas !== null && oldNow === null && newWas === null && newNow !== null;
  });
  const movedFrom = new Set(moves.map((m) => m.from));
  const movedTo = new Set(moves.map((m) => m.to));

  const rows: { sort: string; text: string }[] = [];
  for (const [p, v] of tree.now) {
    if (v === null) {
      if (movedFrom.has(p)) continue;
      if (tree.original(p) === null) continue;
      rows.push({ sort: p, text: `D ${p}` });
    } else {
      const was = tree.original(p);
      if (was === v) continue;
      if (movedTo.has(p)) continue;
      rows.push({ sort: p, text: `${was === null ? 'A' : 'M'} ${p}` });
    }
  }
  for (const m of moves) rows.push({ sort: m.to, text: `R ${m.from} -> ${m.to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort, 'utf8'), Buffer.from(b.sort, 'utf8')));

  if (!check) {
    for (const [p, v] of tree.now) {
      if (v === null) {
        if (tree.original(p) !== null) rmSync(p, { force: true });
      } else if (tree.original(p) !== v) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
