// Paragraph-aware fixed-window chunker for guide content.
//
// Token estimation: chars / 4. We never call a tokenizer — the embedding model
// will count tokens for itself; this estimate is only used to pick window sizes.
//
// Split strategy:
//   1. Paragraphs (\n\n+) are the atomic unit.
//   2. Paragraphs are greedily packed into windows of ~chunkSizeTokens tokens.
//   3. A paragraph that doesn't fit on its own is sentence-split (.!?\n).
//   4. Chunks that are >80% non-alphanumeric (ASCII art, banners) are skipped.
//   5. The first ~chunkOverlapTokens of each chunk overlap the tail of the previous
//      emitted chunk; offsets always reflect positions in the original source.

export interface Chunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

export interface ChunkOpts {
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
}

const CHARS_PER_TOKEN = 4;
const ASCII_ART_THRESHOLD = 0.8;

interface Segment {
  text: string;
  start: number;
  end: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function isMostlyAsciiArt(text: string): boolean {
  const len = text.length;
  if (len === 0) return true;
  let alnum = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 48 && c <= 57) ||  // 0-9
      (c >= 65 && c <= 90) ||  // A-Z
      (c >= 97 && c <= 122)    // a-z
    ) {
      alnum++;
    }
  }
  return (len - alnum) / len > ASCII_ART_THRESHOLD;
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

export function chunkGuide(content: string, opts: ChunkOpts): Chunk[] {
  if (!content || content.trim().length === 0) return [];

  const windowChars = Math.max(1, opts.chunkSizeTokens) * CHARS_PER_TOKEN;
  const overlapChars = Math.max(0, opts.chunkOverlapTokens) * CHARS_PER_TOKEN;

  // Filter ASCII-art paragraphs *before* packing. If we waited until after, an
  // art block packed with adjacent prose would slip through (the merged
  // alnum-density would be acceptable) and the chunk would carry the art.
  const paragraphs = splitParagraphs(content).filter(p => !isMostlyAsciiArt(p.text));

  // Pack paragraphs greedily, sentence-splitting any that exceed the window.
  const packed: Segment[] = [];
  let buf = '';
  let bufStart = -1;
  let bufEnd = -1;
  const flush = () => {
    if (buf.length > 0 && bufStart >= 0) {
      packed.push({ text: buf, start: bufStart, end: bufEnd });
    }
    buf = '';
    bufStart = -1;
    bufEnd = -1;
  };

  for (const para of paragraphs) {
    if (para.text.length > windowChars) {
      // Oversize paragraph — split into sentences first
      flush();
      const sentenceChunks = splitSentences(para, windowChars);
      for (const sc of sentenceChunks) {
        packed.push(sc);
      }
      continue;
    }
    // +2 for the \n\n we'd join paragraphs with (estimate)
    const joinerLen = buf.length === 0 ? 0 : 2;
    if (buf.length + joinerLen + para.text.length > windowChars) {
      flush();
    }
    if (buf.length === 0) {
      bufStart = para.start;
      buf = para.text;
      bufEnd = para.end;
    } else {
      buf += '\n\n' + para.text;
      bufEnd = para.end;
    }
  }
  flush();

  // Apply overlap and emit, skipping ASCII art.
  const chunks: Chunk[] = [];
  let prevTail = '';
  for (const seg of packed) {
    if (isMostlyAsciiArt(seg.text)) continue;

    let combined = seg.text;
    if (overlapChars > 0 && prevTail.length > 0) {
      combined = prevTail + '\n\n' + seg.text;
    }

    chunks.push({
      index: chunks.length,
      content: combined,
      charStart: seg.start,
      charEnd: seg.end,
      tokenCount: estimateTokens(combined),
    });

    prevTail = overlapChars > 0
      ? seg.text.slice(Math.max(0, seg.text.length - overlapChars))
      : '';
  }

  return chunks;
}
