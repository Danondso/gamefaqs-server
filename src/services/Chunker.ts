// Type-aware paragraph-level chunker for guide content.
//
// Pipeline: per-line classification → paragraph-level classification →
// type-aware packing. Each emitted chunk carries one content_type
// ('prose' | 'reference' | 'mixed') and may carry a section_heading. Type
// shifts (prose ↔ reference) force a flush, so a stat block never shares a
// chunk with strategy prose. See CHUNKER_DESIGN.md for heuristic design and
// threshold rationale.
//
// Token estimation: chars / 4. We never call a tokenizer — the embedding model
// will count tokens for itself; this estimate is only used to pick window sizes.

export type ContentType = 'prose' | 'reference' | 'mixed';

export interface Chunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  content_type?: ContentType;
  section_heading?: string;
  /**
   * Comma-joined gated-content tags: any subset of `ng_plus`, `secret`,
   * `missable`. Used by RetrievalService to soft-penalize gated chunks when
   * the question carries no scenario hint.
   */
  scenario?: string;
}

export interface ChunkOpts {
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
}

const CHARS_PER_TOKEN = 4;

interface Segment {
  text: string;
  start: number;
  end: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Detect gated-content scenarios in a chunk's text + heading. Returns a
// comma-joined tag list (deterministic order) or undefined when nothing
// matches. Same patterns as the scenario backfill in migration v6, kept in sync.
//
// Soft heuristic: false positives are tolerable because the retrieval
// penalty is soft (0.7×) and only kicks in on plain questions.
const NG_PLUS_RE = /\bnew game\s*\+|\bNG\+|\bsecond playthrough\b/i;
const SECRET_RE = /\beaster egg\b|\bsecret (?:boss|ending|level|character)\b|\bhidden (?:boss|level)\b/i;
const MISSABLE_RE = /\bmissable\b|\bpoint of no return\b/i;
export function detectScenario(content: string, sectionHeading?: string): string | undefined {
  const haystack = `${sectionHeading ?? ''}\n${content}`;
  const tags: string[] = [];
  if (NG_PLUS_RE.test(haystack)) tags.push('ng_plus');
  if (SECRET_RE.test(haystack)) tags.push('secret');
  if (MISSABLE_RE.test(haystack)) tags.push('missable');
  return tags.length > 0 ? tags.join(',') : undefined;
}

function splitParagraphs(content: string): Segment[] {
  const segments: Segment[] = [];
  const re = /\n{2,}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: content.slice(cursor, match.index), start: cursor, end: match.index });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ text: content.slice(cursor), start: cursor, end: content.length });
  }
  // Drop empty / whitespace-only paragraphs
  return segments.filter(s => s.text.trim().length > 0);
}

function splitSentences(seg: Segment, windowChars: number): Segment[] {
  // Split on sentence terminators (.!?\n) while keeping the terminator with the
  // preceding text. We then greedily group those pieces into sub-paragraphs that
  // each fit inside windowChars. If a single sentence still exceeds the window,
  // we hard-cut it at windowChars boundaries — better a too-big chunk than an
  // infinite loop.
  const re = /[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g;
  const pieces: Segment[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg.text)) !== null) {
    const start = seg.start + m.index;
    pieces.push({ text: m[0], start, end: start + m[0].length });
  }
  if (pieces.length === 0) {
    pieces.push(seg);
  }

  const out: Segment[] = [];
  let buf = '';
  let bufStart = -1;
  let bufEnd = -1;
  const flush = () => {
    if (buf.length > 0 && bufStart >= 0) {
      out.push({ text: buf, start: bufStart, end: bufEnd });
    }
    buf = '';
    bufStart = -1;
    bufEnd = -1;
  };

  for (const p of pieces) {
    if (p.text.length > windowChars) {
      flush();
      // Hard-cut oversize sentence
      let offset = 0;
      while (offset < p.text.length) {
        const slice = p.text.slice(offset, offset + windowChars);
        out.push({ text: slice, start: p.start + offset, end: p.start + offset + slice.length });
        offset += windowChars;
      }
      continue;
    }
    if (buf.length + p.text.length > windowChars) {
      flush();
    }
    if (buf.length === 0) {
      bufStart = p.start;
    }
    buf += p.text;
    bufEnd = p.end;
  }
  flush();
  return out;
}

type LineTag = 'blank' | 'divider' | 'kv' | 'toc' | 'versionlog' | 'name' | 'prose';
type ParaType = 'prose' | 'reference' | 'mixed' | 'header' | 'drop';
type ParaSubtype = 'plain' | 'bordered' | 'kv' | 'list' | 'toc' | 'changelog' | 'divider' | 'banner' | 'mixed';

interface ClassifiedParagraph {
  type: ParaType;
  subtype?: ParaSubtype;
  heading_text?: string;
  text: string;       // original framed/preserved text — kept verbatim for the chunk
  start: number;
  end: number;
}

const RE_BLANK = /^\s*$/;
// Only matches lines whose every char is in the divider class. The
// distinct-char gate (≤ 3 in classifyLine) guards against alternating-pattern
// false positives like `oxoxoxox` (would already fail because `x` isn't in
// the class) but more importantly against `o-o-o-o-o` which is in the class
// and looks like a divider.
const RE_DIVIDER = /^[\s\-=~_*+#%/\\<>o^|]{6,}$/;
// "1 - Section", "[1] - Foo", "4.1.1 - Sub". Right side of the dash must have
// at least one non-space char to avoid matching a bare numeric.
const RE_TOC_NUMERIC = /^\s*\[?\d+\]?\s*[-.)]?\s*\d*(?:\.\d+)*\s*[-.)]\s*\S/;
// "About .... REH002", "Definitions .... 12". Trailing reference token must
// be at least 2 chars to avoid catching "see Foo... 5" tail-of-prose patterns.
const RE_TOC_DOTLEADER = /\.{4,}\s*[A-Z0-9_-]{2,}\s*$/;
// Version, Versão, Versión, v., ver., v1.0
const RE_VERSIONLOG = /^\s*(?:Vers(?:ion|ão|ión)|v(?:er)?\.?)\s*\d/i;
// "HP: 4600" — short label, single colon, value-bearing line. Length cap on
// the label keeps full prose lines like "He thought to himself: ..." from
// matching here on the regex alone; the value-side gates in classifyLine
// handle the rest.
const RE_KV_SHORT = /^\s*[A-Za-z][A-Za-z0-9 %/&'()-]{0,30}:\s+\S/;
// "Lavos Spawn", "Big Smoke" — title-cased entry headers in lists.
const RE_NAME_LINE = /^\s*[A-Z][A-Za-z0-9' .-]{0,40}\s*$/;
// Sentence terminator anywhere in the line (followed by whitespace or EOL).
// Used both for KV value-side gating and for paragraph-level prose density.
const RE_SENT_TERM = /[.!?](?:\s|$)/;

function distinctChars(s: string): number {
  const set = new Set<string>();
  for (const c of s) set.add(c);
  return set.size;
}

function wordCount(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function classifyLine(line: string): LineTag {
  if (RE_BLANK.test(line)) return 'blank';
  const trimmed = line.trim();
  if (RE_DIVIDER.test(trimmed) && distinctChars(trimmed) <= 3) return 'divider';
  if (RE_VERSIONLOG.test(line)) return 'versionlog';
  if (RE_TOC_NUMERIC.test(line) || RE_TOC_DOTLEADER.test(line)) return 'toc';
  if (RE_KV_SHORT.test(line)) {
    // Distinguish "HP: 4600" (kv) from "Strategy: Lorelei is the first..." (prose).
    // The cheap-and-precise gate: a stat value is short and has no sentence
    // terminator. Labeled prose has a terminator inside the value (or wraps
    // and the reader supplies it implicitly — the label-cap regex limits the
    // false-positive surface to where this works).
    const colonIdx = line.indexOf(':');
    const value = line.slice(colonIdx + 1).trim();
    if (value.length <= 50 && !RE_SENT_TERM.test(value)) return 'kv';
  }
  if (RE_NAME_LINE.test(line) && !RE_SENT_TERM.test(line) && wordCount(line) <= 5) return 'name';
  return 'prose';
}

// A paragraph is "bordered" when ≥80% of its lines start with `|` (after
// leading whitespace) AND ≥80% end with `|` (within the last few chars
// before the EOL). This is the projection we run *before* classifyLine on
// the un-framed inner text, so that A2 prose (intact sentences inside an
// ASCII frame) classifies as prose instead of bumping into the border-noise
// pipeline. See CHUNKER_INVESTIGATION.md §2.A and §3.
function isBordered(lines: string[]): boolean {
  if (lines.length === 0) return false;
  let starts = 0;
  let ends = 0;
  for (const L of lines) {
    if (/^\s*\|/.test(L)) starts++;
    if (/\|\s{0,4}$/.test(L)) ends++;
  }
  return starts / lines.length >= 0.8 && ends / lines.length >= 0.8;
}

function unframe(line: string): string {
  return line.replace(/^\s*\|\s?/, '').replace(/\s?\|\s*$/, '');
}

function classifyParagraph(originalLines: string[], classifyLines: string[]): {
  type: ParaType;
  subtype?: ParaSubtype;
  heading_text?: string;
} {
  // originalLines: framed/raw lines used for line-length and terminator stats.
  // classifyLines: same lines but unframed when the paragraph is bordered.
  const lineTags = classifyLines.map(classifyLine);
  const c = { prose: 0, kv: 0, toc: 0, versionlog: 0, name: 0, divider: 0 };
  let total = 0;
  for (const t of lineTags) {
    if (t === 'blank') continue;
    total++;
    if (t in c) (c as any)[t]++;
  }
  if (total === 0) return { type: 'drop' };

  // Pure noise — divider runs as their own paragraph
  if (c.divider / total >= 0.8) return { type: 'drop', subtype: 'divider' };

  // Hard reference shapes. Order matters: versionlog before toc before kv,
  // because a `Versão 0.27 - 23/04/2005 - text` line passes the toc-numeric
  // regex too (the leading version date looks numeric-prefixed).
  if (c.versionlog / total >= 0.5) return { type: 'reference', subtype: 'changelog' };
  if (c.toc / total >= 0.5) return { type: 'reference', subtype: 'toc' };

  // KV-dominant: stat blocks. The second leg tolerates a name-line per pair
  // of kv lines (entry header inside a list-of-entries like the Charm FAQ);
  // c.kv ≥ 2 keeps us from over-firing on a 1-kv single-name pair that's
  // really a section banner.
  if (c.kv / total >= 0.5 || ((c.kv + c.name) / total >= 0.7 && c.kv >= 2)) {
    return { type: 'reference', subtype: c.name > 0 ? 'list' : 'kv' };
  }

  // Short-line stat-list fallback for non-KV-shaped reference paragraphs:
  // Pokemon team listings, formation tables, etc. Catches lines like
  // "Erika has Victreebel - Lvl. 29" that have no `:` to make them KV-shaped.
  let totalLen = 0;
  let withSentTerm = 0;
  for (const L of originalLines) {
    totalLen += L.length;
    if (RE_SENT_TERM.test(L)) withSentTerm++;
  }
  const avgLineLen = totalLen / originalLines.length;
  const fracSent = withSentTerm / originalLines.length;
  if (total >= 4 && avgLineLen <= 60 && fracSent < 0.2) {
    return { type: 'reference', subtype: 'list' };
  }

  // Single short non-terminated line: a banner / section header. Only fires
  // when nothing already pulled the paragraph into reference territory above
  // (versionlog / toc / kv all have higher precedence). c.prose === 0 keeps
  // a 1-line full-sentence paragraph from getting treated as a header.
  let maxLineLen = 0;
  for (const L of originalLines) if (L.length > maxLineLen) maxLineLen = L.length;
  if (total <= 2 && maxLineLen <= 60 && c.prose === 0 && c.name <= 2) {
    return {
      type: 'header',
      subtype: 'banner',
      heading_text: originalLines.map(L => L.trim()).filter(Boolean).join(' '),
    };
  }

  if (c.prose / total >= 0.5) {
    return { type: 'prose', subtype: isBordered(originalLines) ? 'bordered' : 'plain' };
  }

  // Anything else — a paragraph the classifier wasn't confident about.
  return { type: 'mixed', subtype: 'mixed' };
}

function classifyAllParagraphs(paragraphs: Segment[]): ClassifiedParagraph[] {
  const out: ClassifiedParagraph[] = [];
  for (const p of paragraphs) {
    const rawLines = p.text.split('\n');
    const bordered = isBordered(rawLines);
    const classifyLines = bordered ? rawLines.map(unframe) : rawLines;
    const klass = classifyParagraph(rawLines, classifyLines);
    out.push({
      type: klass.type,
      subtype: klass.subtype,
      heading_text: klass.heading_text,
      text: p.text,
      start: p.start,
      end: p.end,
    });
  }
  return out;
}

function paraTypeToContent(t: ParaType): ContentType {
  return t === 'mixed' ? 'mixed' : t === 'reference' ? 'reference' : 'prose';
}

function packTypeAwareChunks(
  paragraphs: ClassifiedParagraph[],
  windowChars: number,
  overlapChars: number
): Chunk[] {
  const out: Chunk[] = [];

  // Buffer state: a run of same-typed paragraphs (or mixed paragraphs joining
  // a stronger-typed run).
  let buf: ClassifiedParagraph[] = [];
  let bufType: ParaType | null = null;
  let bufStart = -1;
  let bufEnd = -1;
  let bufLength = 0;
  let pendingHeading: string | undefined = undefined;

  // Tail of the *raw* (overlap-free) text of the last emitted chunk, used to
  // build the next chunk's leading overlap. Tracked separately so overlap
  // doesn't accumulate when a chunk inherits a tail and then donates its own
  // tail — the donation is taken from the raw text, not the overlap-prefixed
  // content. (The v1 chunker has the same property; preserving it.)
  let lastEmittedType: ContentType | null = null;
  let lastEmittedTail = '';

  const emit = (
    rawText: string,
    charStart: number,
    charEnd: number,
    ct: ContentType,
    heading: string | undefined
  ): void => {
    let combined = rawText;
    if (overlapChars > 0 && lastEmittedType === ct && lastEmittedTail) {
      combined = lastEmittedTail + '\n\n' + rawText;
    }
    out.push({
      index: out.length,
      content: combined,
      charStart,
      charEnd,
      tokenCount: estimateTokens(combined),
      content_type: ct,
      section_heading: heading,
      scenario: detectScenario(combined, heading),
    });
    lastEmittedType = ct;
    lastEmittedTail = overlapChars > 0
      ? rawText.slice(Math.max(0, rawText.length - overlapChars))
      : '';
  };

  const flush = (): void => {
    if (buf.length === 0) return;
    const text = buf.map(p => p.text).join('\n\n');
    const ct = paraTypeToContent(bufType ?? 'prose');
    emit(text, bufStart, bufEnd, ct, pendingHeading);
    buf = [];
    bufType = null;
    bufStart = -1;
    bufEnd = -1;
    bufLength = 0;
    pendingHeading = undefined;
  };

  for (const p of paragraphs) {
    if (p.type === 'drop') continue;

    if (p.type === 'header') {
      // Header attaches to the *next* content block. If buf is non-empty
      // (we're mid-prose), flush it first so the header lines up with what
      // comes after the flush, not what came before.
      if (buf.length > 0) flush();
      pendingHeading = p.heading_text;
      continue;
    }

    // Type shift: prose ↔ reference forces a flush. mixed is a sink type and
    // can pack into either neighbor.
    if (
      bufType !== null &&
      bufType !== p.type &&
      bufType !== 'mixed' &&
      p.type !== 'mixed'
    ) {
      flush();
    }

    // Size check: flush if adding this paragraph would exceed the window.
    const joinerLen = buf.length === 0 ? 0 : 2;
    if (bufLength + joinerLen + p.text.length > windowChars && buf.length > 0) {
      flush();
    }

    // Oversize paragraph fallback: sentence-split, each piece carries the
    // parent paragraph's content_type. Heading attaches to the first piece
    // only (subsequent pieces get undefined), matching the "header attaches
    // forward to one block" rule.
    if (p.text.length > windowChars) {
      flush();
      const pieces = splitSentences({ text: p.text, start: p.start, end: p.end }, windowChars);
      const ct = paraTypeToContent(p.type);
      for (const piece of pieces) {
        emit(piece.text, piece.start, piece.end, ct, pendingHeading);
        pendingHeading = undefined;
      }
      continue;
    }

    // Pack
    if (buf.length === 0) {
      bufType = p.type;
      bufStart = p.start;
    } else if (bufType === 'mixed' && p.type !== 'mixed') {
      // A stronger-typed paragraph joins a mixed buffer. The emitted chunk
      // takes the stronger type — we only emit `mixed` when a mixed paragraph
      // stood alone (or only packed with other mixed paragraphs).
      bufType = p.type;
    }
    buf.push(p);
    bufEnd = p.end;
    bufLength += joinerLen + p.text.length;
  }

  flush();
  return out;
}

export function chunkGuide(content: string, opts: ChunkOpts): Chunk[] {
  if (!content || content.trim().length === 0) return [];

  const windowChars = Math.max(1, opts.chunkSizeTokens) * CHARS_PER_TOKEN;
  const overlapChars = Math.max(0, opts.chunkOverlapTokens) * CHARS_PER_TOKEN;

  const paragraphs = splitParagraphs(content);
  const classified = classifyAllParagraphs(paragraphs);
  return packTypeAwareChunks(classified, windowChars, overlapChars);
}

// Internal exports for unit tests. Not part of the public API; the indexer
// only calls chunkGuide.
export const __testing = {
  classifyLine,
  classifyParagraph,
  isBordered,
  unframe,
};
