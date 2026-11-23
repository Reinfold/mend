// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// --- Line model (SPEC.md section 3) ---

export interface FileText {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

/** Split a file's text at its line break: CRLF when the first line feed follows a carriage return, else LF. */
export function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

/** Join a file's lines back: no lines writes empty; otherwise the lines joined by br, plus a final br when final. */
export function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// --- Matching (SPEC.md section 5) ---

export type Tier = 0 | 1 | 2;

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** tier 0: exact; tier 1: trailing spaces/tabs removed from both; tier 2: leading and trailing removed. */
export function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** All positions i >= from where O matches lines[i .. i+O.length-1] at tier. Overlapping allowed. */
export function occurrences(O: string[], lines: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  const n = O.length;
  for (let i = Math.max(0, from); i + n <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 when strict) with >= 1 occurrence at/after `from`. Null when none. */
export function findTier(O: string[], lines: string[], from: number, strict: boolean): { tier: Tier; positions: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(O, lines, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// --- Replacement (SPEC.md section 5) ---

export interface PatLine {
  text: string;
  context: boolean;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/**
 * Replace the k = oldLines.length matched lines at pos with newLines.
 * A context line of newLines is written as the file's own matched line (the j-th context line of newLines
 * maps to the j-th context line of oldLines). At tier 2, every other line of newLines that is not empty and
 * not only whitespace and starts with P (the leading spaces/tabs of oldLines[0]) has that P replaced by F
 * (the leading spaces/tabs of the file's first matched line); any other line is written as it is. At tiers
 * 0 and 1 newLines are written as-is. When oldLines is empty (an insertion) no tier-2 re-indent applies.
 * The result keeps the file's break and takes finalBreak as its final break.
 */
export function replaceAt(file: FileText, pos: number, oldLines: PatLine[], newLines: PatLine[], tier: Tier, finalBreak: boolean): FileText {
  const k = oldLines.length;
  const oldCtx: number[] = [];
  for (let i = 0; i < k; i += 1) if (oldLines[i]!.context) oldCtx.push(i);
  const p = k === 0 ? '' : leadingWs(oldLines[0]!.text);
  const f = k === 0 ? '' : leadingWs(file.lines[pos] ?? '');
  let ctx = 0;
  const written = newLines.map((nl) => {
    if (nl.context) {
      const at = oldCtx[ctx];
      ctx += 1;
      return at === undefined ? nl.text : (file.lines[pos + at] ?? nl.text);
    }
    if (tier === 2 && k > 0) {
      const t = nl.text;
      // The spec's rule as written: a line starting with P has that P replaced by F. When P is empty
      // (O's first line has no leading whitespace) every line starts with P, so F is prepended; the
      // spec carves out no exception for an empty P, so none is made here.
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return nl.text;
  });
  return { br: file.br, lines: [...file.lines.slice(0, pos), ...written, ...file.lines.slice(pos + k)], final: finalBreak };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits recorded, in order: { old, next }. Read by run()'s exit-0 writer for `R` lines. */
  readonly moves: Array<{ old: string; next: string }> = [];
  recordMove(old: string, next: string): void {
    this.moves.push({ old, next });
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

/** Unified diffs (SPEC.md section 6). One Edit per section, applied in order. */
export function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Hunk {
    a: number;
    o: PatLine[];
    n: PatLine[];
    /** A `\` line follows the hunk's last context or `+` body line. */
    noNL: boolean;
    /** A `\` line follows the hunk's last `+` body line; null when it has no `+` lines. */
    lastPlusNoNL: boolean | null;
  }
  interface Section {
    diffOld: string | null;
    diffNew: string | null;
    hasPair: boolean;
    pairOld: string | null;
    pairNew: string | null;
    renameOld: string | null;
    renameNew: string | null;
    createFlag: boolean;
    deleteFlag: boolean;
    hunks: Hunk[];
  }
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  // The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed;
  // `/dev/null` means no file; a leading `a/` or `b/` is removed.
  const cleanPath = (raw: string): string | null => {
    const t = raw.split('\t')[0]!.trim();
    if (t === '/dev/null') return null;
    if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
    return t;
  };
  const newSection = (diffOld: string | null, diffNew: string | null): Section => ({
    diffOld,
    diffNew,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    createFlag: false,
    deleteFlag: false,
    hunks: [],
  });
  // Parse one hunk body starting just after its header at `at`; returns the hunk
  // and the index of the first line after the body.
  const parseHunk = (at: number): { hunk: Hunk; next: number } => {
    const m = hunkRe.exec(lines[at]!);
    const a = Number(m![1]);
    const raw: string[] = [];
    let j = at + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        raw.push(l);
        j += 1;
        continue;
      }
      break;
    }
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    const kinds: Array<'ctx' | 'old' | 'new' | 'mark'> = raw.map((l) =>
      l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : l.startsWith('+') ? 'new' : 'mark',
    );
    let lastCtxPlus = -1;
    let lastPlus = -1;
    for (let k = 0; k < kinds.length; k += 1) {
      if (kinds[k] === 'ctx' || kinds[k] === 'new') lastCtxPlus = k;
      if (kinds[k] === 'new') lastPlus = k;
    }
    const o: PatLine[] = [];
    const n: PatLine[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (kinds[k] === 'ctx') {
        const t = l === '' ? '' : l.slice(1);
        o.push({ text: t, context: true });
        n.push({ text: t, context: true });
      } else if (kinds[k] === 'old') o.push({ text: l.slice(1), context: false });
      else if (kinds[k] === 'new') n.push({ text: l.slice(1), context: false });
    }
    return {
      hunk: {
        a,
        o,
        n,
        noNL: lastCtxPlus >= 0 && raw[lastCtxPlus + 1] !== undefined && raw[lastCtxPlus + 1]!.startsWith('\\'),
        lastPlusNoNL:
          lastPlus < 0 ? null : raw[lastPlus + 1] !== undefined && raw[lastPlus + 1]!.startsWith('\\'),
      },
      next: j,
    };
  };

  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const oldP = cleanPath(l.slice(4));
        const newP = cleanPath(lines[i + 1]!.slice(4));
        if (cur !== null && cur.hunks.length === 0) {
          cur.hasPair = true;
          cur.pairOld = oldP;
          cur.pairNew = newP;
        } else {
          cur = newSection(null, null);
          cur.hasPair = true;
          cur.pairOld = oldP;
          cur.pairNew = newP;
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      // A `--- ` line not followed by a `+++ ` line, inside a section's header.
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (hunkRe.exec(l) === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Still in the section's header: rename lines and file-mode lines name the
      // section; every other line is ignored.
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.createFlag = true;
      else if (l.startsWith('deleted file mode')) cur.deleteFlag = true;
    }
    i += 1;
  }

  // Apply one section's hunks in order to the text of `src`; `errPath` is the path
  // a hunk failure is reported against. Returns the resulting text.
  const applyHunks = (src: string, hunks: Hunk[], errPath: string): string => {
    let file = splitFile(src);
    let d = 0;
    for (const h of hunks) {
      const oTexts = h.o.map((p) => p.text);
      if (oTexts.length === 0) {
        const pos = Math.min(Math.max(0, h.a + d), file.lines.length);
        const atEnd = pos === file.lines.length;
        file = replaceAt(file, pos, [], h.n, 0, atEnd ? !h.noNL : file.final);
      } else {
        const found = findTier(oTexts, file.lines, 0, strict);
        if (found === null) throw new Fail('no-match', errPath);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const atEnd = best + oTexts.length === file.lines.length;
        file = replaceAt(file, best, h.o, h.n, found.tier, atEnd ? !h.noNL : file.final);
      }
      d += h.n.length - h.o.length;
    }
    return joinFile(file);
  };

  const edits: Edit[] = [];
  for (const sec of sections) {
    // The `---`/`+++` pair names both paths when there is one; otherwise each
    // path falls back to its `rename` line, then to its `diff --git` path.
    const oldP = sec.hasPair ? sec.pairOld : (sec.renameOld ?? sec.diffOld);
    const newP = sec.hasPair ? sec.pairNew : (sec.renameNew ?? sec.diffNew);
    if (oldP === null || sec.createFlag) {
      // Creation: the new path does not exist; the file is the `+` lines of all
      // its hunks, in order, ending with a line break unless a `\` line follows
      // its last `+` line. A creation with no new path (for example `new file
      // mode` with `+++ /dev/null`) names no file to create, so it fails
      // rather than creating a file at a path the patch never named.
      const newPath = newP;
      const hunks = sec.hunks;
      edits.push((tree) => {
        if (newPath === null) throw new Fail('missing', oldP ?? '');
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        let lastNoNL: boolean | null = null;
        for (const h of hunks) {
          for (const p of h.n) if (!p.context) plus.push(p.text);
          if (h.lastPlusNoNL !== null) lastNoNL = h.lastPlusNoNL;
        }
        tree.now.set(newPath, joinFile({ br: '\n', lines: plus, final: !(lastNoNL ?? false) }));
      });
    } else if (newP === null || sec.deleteFlag) {
      // Deletion: the old path exists; it is deleted, and its hunks are not read.
      const oldPath = oldP;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      });
    } else if (oldP !== newP) {
      // Move: hunks apply to the old file's lines, the result is written at the
      // new path, the old path deleted.
      const oldPath = oldP;
      const newPath = newP;
      const hunks = sec.hunks;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const curText = tree.get(oldPath);
        if (curText === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(curText, hunks, oldPath);
        tree.now.set(newPath, out);
        tree.now.set(oldPath, null);
        tree.recordMove(oldPath, newPath);
      });
    } else {
      // Change of the one path, which exists.
      const path = oldP;
      const hunks = sec.hunks;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const curText = tree.get(path);
        if (curText === null) throw new Fail('missing', path);
        tree.now.set(path, applyHunks(curText, hunks, path));
      });
    }
  }
  return edits;
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). One Edit per block, applied in order. */
export function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let windowStart = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, after the previous block's
    // >>>>>>> REPLACE line (or the start of the patch), that is not blank and, with
    // surrounding whitespace removed, does not start with three backticks.
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= windowStart; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (lastPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = lastPath;
    }
    const p = path;
    // The ======= line, then the >>>>>>> REPLACE line, after the SEARCH line. A
    // >>>>>>> REPLACE line or another SEARCH line before the ======= means this
    // block never had a separator: it is a parse error at the SEARCH line.
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    if (oldLines.length === 0) {
      // Empty old lines create the file with the new lines, ending with a line break.
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile({ br: '\n', lines: [...newLines], final: true }));
      });
    } else {
      const oldPat: PatLine[] = oldLines.map((t) => ({ text: t, context: false }));
      const newPat: PatLine[] = newLines.map((t) => ({ text: t, context: false }));
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        const file = splitFile(cur);
        const found = findTier(oldLines, file.lines, 0, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.positions.length !== 1) throw new Fail('ambiguous', p);
        tree.now.set(p, joinFile(replaceAt(file, found.positions[0]!, oldPat, newPat, found.tier, file.final)));
      });
    }
    lastPath = p;
    windowStart = end + 1;
    i = end + 1;
  }
  return edits;
}

/** V4A patches (SPEC.md section 8). One Edit per section, applied in order. */
export function v4aEdits(lines: string[], strict: boolean): Edit[] {
  interface Chunk {
    anchor: string | null;
    eof: boolean;
    o: PatLine[];
    n: PatLine[];
  }
  // The first non-blank line is `*** Begin Patch` and the last non-blank line
  // is `*** End Patch`, both compared with surrounding whitespace removed.
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const headerKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = headerKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = l.slice(kind === 'add' ? 14 : 17).trim();
    // The section's raw lines run to the next section header or `*** End Patch`.
    // Blank lines at the end of a section are not part of it, so they are dropped
    // here; blank lines between sections are therefore ignored as well.
    const raw: Array<{ text: string; line: number }> = [];
    let j = i + 1;
    while (j < last && headerKind(lines[j]!) === null) {
      raw.push({ text: lines[j]!, line: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      // An Add File section's lines start with `+` (the rest is a line of the
      // file) or are empty (an empty line of the file).
      const fileLines: string[] = [];
      for (const { text, line } of raw) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${line}`);
      }
      const p = path;
      const created = [...fileLines];
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile({ br: '\n', lines: created, final: true }));
      });
    } else if (kind === 'delete') {
      // A Delete File section has no lines; blank lines inside it are ignored.
      for (const { text, line } of raw) {
        if (!blank(text)) throw new Exit2(`error: parse ${line}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      // Update File: an optional `*** Move to: <path>` first line, then chunks.
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(12).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < raw.length; k += 1) {
        const { text, line } = raw[k]!;
        if (text.startsWith('@@')) {
          // The text after `@@`, with surrounding spaces removed, is the
          // chunk's anchor; an empty text is no anchor.
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          chunks.push(cur);
          continue;
        }
        if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${line}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
          if (cur === null) {
            // A body line starts the first chunk; after a chunk ended with
            // `*** End of File` only an `@@` line can start another chunk.
            if (chunks.length > 0) throw new Exit2(`error: parse ${line}`);
            cur = { anchor: null, eof: false, o: [], n: [] };
            chunks.push(cur);
          }
          if (text === '' || text.startsWith(' ')) {
            const t = text === '' ? '' : text.slice(1);
            cur.o.push({ text: t, context: true });
            cur.n.push({ text: t, context: true });
          } else if (text.startsWith('-')) cur.o.push({ text: text.slice(1), context: false });
          else cur.n.push({ text: text.slice(1), context: false });
          continue;
        }
        throw new Exit2(`error: parse ${line}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const p = path;
      const dest = moveTo;
      const sectionChunks = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
        let file = splitFile(curText);
        let cursor = 0;
        for (const chunk of sectionChunks) {
          if (chunk.anchor !== null) {
            const anchorFound = findTier([chunk.anchor], file.lines, cursor, strict);
            if (anchorFound === null) throw new Fail('no-match', p);
            cursor = anchorFound.positions[0]! + 1;
          }
          const oTexts = chunk.o.map((x) => x.text);
          if (oTexts.length === 0) {
            // Empty O inserts N at the cursor, or at the end of the file for
            // an end-of-file chunk. The cursor can run past the end of the
            // file (a growing end-of-file chunk leaves it at pos + N.length),
            // and an insertion past the end lands at the end.
            const pos = chunk.eof ? file.lines.length : Math.min(cursor, file.lines.length);
            file = replaceAt(file, pos, [], chunk.n, 0, file.final);
            cursor = pos + chunk.n.length;
          } else {
            const found = findTier(oTexts, file.lines, cursor, strict);
            if (found === null) throw new Fail('no-match', p);
            let pos: number | null = null;
            if (chunk.eof) {
              // An end-of-file chunk takes only an occurrence that ends at the
              // file's last line.
              for (const q of found.positions) {
                if (q + oTexts.length === file.lines.length) {
                  pos = q;
                  break;
                }
              }
              if (pos === null) throw new Fail('no-match', p);
            } else {
              pos = found.positions[0]!;
            }
            // V4A has no `\ No newline` marker, so a changed file keeps its
            // final break exactly as it was (SPEC.md section 3).
            file = replaceAt(file, pos, chunk.o, chunk.n, found.tier, file.final);
            cursor = pos + chunk.n.length;
          }
        }
        const out = joinFile(file);
        if (dest !== null) {
          tree.now.set(dest, out);
          tree.now.set(p, null);
          tree.recordMove(p, dest);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  return edits;
}

export function run(args: string[]): { code: number; out: string[] } {
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
            ? srEdits(lines, strict)
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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  if (!check) {
    for (const p of [...changed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // A recorded move whose old path existed before the patch and does not after it, and whose new path
  // did not exist before it and does after it, is one line `R <old> -> <new>` sorted by <new>; its old
  // and new paths get no separate A/D lines. Every other changed path gets `A`/`D`/`M <path>`.
  const moved = new Set<string>();
  const entries: Array<{ key: string; line: string }> = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) === null || tree.get(m.old) !== null) continue;
    if (tree.original(m.next) !== null || tree.get(m.next) === null) continue;
    moved.add(m.old);
    moved.add(m.next);
    entries.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
  }
  for (const p of changed) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


// Only run the CLI when this file is the entry point: importing main.ts (for example from a unit test)
// must not run it. process.argv[1] is the entry path as invoked, so resolve it against the working
// directory before comparing it with this file's own path; that keeps both `node main.ts` and
// `node /abs/path/main.ts` working, and the MAKEFUN_ENV_URL hand-over below behaves exactly as before
// when this file is the entry point.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
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
}
