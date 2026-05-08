# Chunker design

The type-aware chunker classifies every line and paragraph, then packs
chunks so each one holds a single content type, carries a `content_type`
tag, and respects natural section boundaries in the source. This is the
load-bearing design doc; `CHUNKER_INVESTIGATION.md` (archival) inventories
the failure modes of the previous greedy paragraph-packing implementation
that motivated this design.

## 0. Output contract

The new chunker emits chunks with:

```ts
interface Chunk {
  index: number;
  content: string;         // unchanged: original source text, frame-preserved
  charStart: number;       // unchanged: offset in original source
  charEnd: number;
  tokenCount: number;
  content_type: 'prose' | 'reference' | 'mixed';  // NEW
  section_heading?: string; // NEW (optional): nearest preceding header text
}
```

Two new fields. `content_type` is the load-bearing one for the failure
class we're targeting. `section_heading` is opportunistic — when a header
attaches to a chunk's leading content, surface its text. Synthesis can use
it for citation; retrieval changes are out of scope here.

Schema migration v11 adds:
```sql
ALTER TABLE chunks ADD COLUMN content_type TEXT NOT NULL DEFAULT 'prose';
ALTER TABLE chunks ADD COLUMN section_heading TEXT;
```

The migration default is `'prose'` so existing rows are not retroactively
demoted; they will be re-tagged when their guides re-index.

## 1. Pipeline

```
guide.content
   │
   ▼  splitParagraphs   (existing logic, unchanged)
   │
   ▼  classifyParagraph (NEW)  →  paragraph.type ∈ {prose, reference, header, mixed, drop}
   │                                paragraph.subtype ∈ {plain, bordered, kv, list, toc, changelog, divider, banner}
   │                                paragraph.heading_text (only when type === header)
   │
   ▼  packTypeAwareChunks (NEW)  →  Chunk[]
```

Three additions on top of the existing pipeline. No new tokenizer pass; no
change to `chunkSizeTokens` / `chunkOverlapTokens` defaults; no Ollama call.
Pure-text logic, runs in the same per-guide budget as today.

## 2. Per-line classification

For each line `L` (after stripping trailing `\r`/`\n`, with surrounding
whitespace preserved for indent detection), compute one tag from this
ordered match:

```
type Tag = 'blank' | 'divider' | 'kv' | 'toc' | 'versionlog' | 'name' | 'prose'

const BLANK         = /^\s*$/
const DIVIDER       = /^[\s\-=~_*+#%/\\<>o^|]{6,}$/        // applied to L.trim()
const TOC_NUMERIC   = /^\s*\[?\d+\]?\s*[-.)]?\s*\d*(?:\.\d+)*\s*[-.)]\s*\S/
const TOC_DOTLEADER = /\.{4,}\s*[A-Z0-9_-]{2,}\s*$/        // "About .... REH002"
const VERSIONLOG    = /^\s*(?:Vers(?:ion|ão|ión)|v(?:er)?\.?)\s*\d/i
const KV_SHORT      = /^\s*[A-Za-z][A-Za-z0-9 %/&'()-]{0,30}:\s+\S/   // "HP: 4600"
const NAME_LINE     = /^\s*[A-Z][A-Za-z0-9' .-]{0,40}\s*$/             // "Lavos Spawn"
const SENT_TERM     = /[.!?](?:\s|$)/
```

```
classifyLine(L):
  s = L.trim()
  if BLANK.test(L) → blank
  if DIVIDER.test(s) AND distinct(s) ≤ 3 → divider
  if VERSIONLOG.test(L) → versionlog
  if TOC_NUMERIC.test(L) OR TOC_DOTLEADER.test(L) → toc
  if KV_SHORT.test(L):
    valueAfterColon = L.slice(L.indexOf(':')+1).trim()
    if valueAfterColon.length ≤ 50 AND !SENT_TERM.test(valueAfterColon) → kv
    // labels with long prose values fall through to prose,
    // e.g. "Strategy: Lorelei is the first opponent..."
  if NAME_LINE.test(L) AND !SENT_TERM.test(L) AND wordCount(L) ≤ 5 → name
  else → prose
```

Frame-strip is applied **before** classification when the *paragraph* matches
the bordered pattern (§3.1). Stripping is a classification-time projection;
chunk content stays in the original framed form.

### What each line heuristic catches / misses

**`DIVIDER`** catches `------`, `~~~~`, `====`, `%%%%%`, `oooo`, `////`, ASCII
banners (`mmmmmmmmmm...`). The `distinct ≤ 3` guard prevents matching long
mixed-letter strings. Misses: short 5-char divider like `=====` (intentional
— too easy to false-fire).

**`TOC_NUMERIC`** catches `1 - Changelog`, `4.1.1 - Capítulo 1`, `[1] - `,
`9.6 - Último Capítulo`. Misses: a TOC entry like `Changelog ............. 1`
(uses `TOC_DOTLEADER` for that). Doesn't fire on `Versão 0.27 - 23/04/2005`
because the prefix is `Versão` not numeric.

**`TOC_DOTLEADER`** catches `About This Guide ........ REH002`,
`Definitions ........ REH004`. Misses: `... and so on.` in prose (only 3 dots,
threshold is 4).

**`VERSIONLOG`** catches `Version: 0.40`, `Versão 0.27`, `Versión 1.0.`, `v1.5`.
Misses: in-text mention like `the version 1.0 release of ...` (has leading text).

**`KV_SHORT`** catches `HP: 4600`, `Att%: 100`, `Charm: Barrier`,
`Element: Cut`, `Reward: $5544`. The 30-char label cap excludes things like
`This is a very long sentence: with a colon in it`. The value-length / no-
terminator gate is what saves us from `Strategy: ... [full sentence].` — that
falls through to `prose`.

**`NAME_LINE`** catches `Lavos Spawn`, `Erika`, `Big Smoke` — short title-cased
single-line entry headings inside lists. The 5-word cap excludes whole
sentences. Distinguishes a Charm-FAQ entry header from a TOC line (which
has numeric prefixes) and from prose (which has terminators).

**`prose`** catches everything else, including labeled-prose lines like
`Strategy: ...full sentence...` and free-form narrative.

## 3. Frame strip (paragraph-level normalization)

A paragraph (run of contiguous non-blank lines from `splitParagraphs`) is
**bordered** if:

- ≥ 80% of lines start with `|` (after leading whitespace), AND
- ≥ 80% of those lines also end with `|` within the last 5 chars before
  the line's terminator/EOL.

```
isBordered(lines):
  starts = sum(1 for L in lines if /^\s*\|/.test(L))
  ends   = sum(1 for L in lines if /\|\s{0,4}$/.test(L))
  return starts / lines.length ≥ 0.8 AND ends / lines.length ≥ 0.8

unframe(line):
  return line.replace(/^\s*\|\s?/, '').replace(/\s?\|\s*$/, '')
```

Run `unframe` over each line and classify the unframed result. The test fires
on both A2 (bordered prose) and B-shape (boxed stat blocks) — the inner
content is what tells them apart.

### Catches / misses

- ✓ Catches DynamixDJ Sephiroth strategy (chunk 2085): inner lines are
  full sentences ("Cloud can remain idle...") → classify as `prose`.
- ✓ Catches DynamixDJ stat blocks (chunks 1939, 1948, ...): inner lines are
  KV pairs (`Attack 1: <Sephiroth Shock>`, `Element: Cut`, `Power: 10`) →
  classify as `kv` → paragraph rolls up to `reference`.
- ✓ Catches KoritheMan boss blocks (Lavos chunk 264): inner lines are KV
  (`HP: (Center Bit) 10000`, `Defense: (Lavos Core) 255`).
- ✗ Misses: a paragraph that's mostly bordered but has 1-2 straggler lines
  starting at column 0 (a comment outside the box). The 80% threshold
  tolerates this; if the straggler is prose it slightly tilts the rollup
  toward `mixed`. Acceptable.
- ✗ Misses: paragraphs where the right border is irregular (bottom cap
  `<` or `o`-marks). Can extend the right-edge regex to accept `[|<o]` —
  defer until we see it bite.

## 4. Paragraph-level classification

After per-line classification (with frame-strip if applicable):

```
classifyParagraph(lines, lineTags):
  total = count(t for t in lineTags if t !== 'blank')
  if total === 0: return { type: 'drop' }

  c = { prose:0, kv:0, toc:0, versionlog:0, name:0, divider:0 }
  for t in lineTags: c[t] += 1

  // Pure noise
  if c.divider / total ≥ 0.8: return { type: 'drop', subtype: 'divider' }

  // Hard reference shapes (low recall on prose, high precision on noise)
  if c.versionlog / total ≥ 0.5:
      return { type: 'reference', subtype: 'changelog' }
  if c.toc / total ≥ 0.5:
      return { type: 'reference', subtype: 'toc' }

  // KV-dominant: stat blocks. Tolerate a `name` line per kv block (entry
  // header inside a list-of-entries like the Charm FAQ).
  if c.kv / total ≥ 0.5 OR (c.kv + c.name) / total ≥ 0.7 AND c.kv ≥ 2:
      return { type: 'reference', subtype: c.name > 0 ? 'list' : 'kv' }

  // Heuristic for short-line stat lists that aren't KV-shaped (Pokemon
  // team listings: "Erika has Victreebel - Lvl. 29")
  if total ≥ 4
     AND avgLineLen(lines) ≤ 60
     AND fractionWithSentTerm(lines) < 0.2:
      return { type: 'reference', subtype: 'list' }

  // Single short non-terminated line surrounded by blanks/dividers
  if total ≤ 2 AND maxLineLen(lines) ≤ 60 AND c.prose === 0 AND c.name ≤ 2:
      return { type: 'header', subtype: 'banner', heading_text: lines.join(' ').trim() }

  // Prose-dominant
  if c.prose / total ≥ 0.5:
      return { type: 'prose', subtype: bordered ? 'bordered' : 'plain' }

  // Anything else
  return { type: 'mixed', subtype: 'mixed' }
```

### Classification examples (validate against the bench-qa.txt samples)

**Q1 chunk 2085 (Sephiroth strategy, bordered prose):**
- 16 inner lines after unframe, all full sentences with terminators.
- `c = {prose: 14, kv: 0, ...}` → 14/14 prose → `{ type: 'prose', subtype: 'bordered' }`. ✓

**Q1 chunk 1976 (Sephiroth attack pipe-grid):**
- 26 inner lines after unframe. Lines like `Attack 1: <Sephiroth Shock>...`,
  `[3AC]   Physical   Element: Cut`, `Power: 10`.
- `c = {kv: 18, prose: 2, name: 4, ...}` → kv-dominant → `{ type: 'reference', subtype: 'kv' }`. ✓

**Q7 KoritheMan chunk 264 (mixed prose + boss block):**
- After splitParagraphs, this is at least 2 paragraphs separated by `\n\n`.
  Paragraph A: prose ("Once he is defeated, the final battle with Lavos
  will commence..."). Paragraph B: boss block (`HP:`, `Attack:`, `Defense:`,
  ...).
- Classify each independently: A → `prose/plain`, B → `reference/kv`.
- Pack-time: type shift causes a flush between them. → 2 chunks instead of 1.

**Q7 AdrenalineSL Charm FAQ entries:**
- Each entry is a 3-line paragraph: 1 name + 2 kv. Total 3 lines, c.kv=2, c.name=1.
- (c.kv + c.name) / total = 3/3 = 1.0 ≥ 0.7 AND c.kv ≥ 2 → `reference/list`. ✓

**Q5 Lord_Pignea chunk 0 (Portuguese TOC):**
- 30+ lines, mostly `1 - Changelog`, `2 - Controles`, `4.1 - Capítulo 1`.
- c.toc / total ≥ 0.7 → `reference/toc`. ✓

**Q5 Joe Zakutny chunk 1 (TOC with dot leaders):**
- 8 lines like `About This Guide ........ REH002`.
- All match TOC_DOTLEADER → `reference/toc`. ✓

**Q5 Lord_Pignea chunk 2 (changelog):**
- 15 lines all matching `Versão 0.XX - <date> - <text>`.
- c.versionlog / total ≥ 0.5 → `reference/changelog`. ✓

**Q14 Adnan Javed chunk 59 (RE4 church prose):**
- ~30 lines, all flowing prose.
- c.prose / total ≥ 0.5 → `prose/plain`. ✓

**Q4 KoritheMan Pokemon strategy (Q4 elite four):**
- Lines like `Elite Four: Lorelei` (kv), `Location: Indigo Plateau` (kv),
  `Trainer's Pokemon: Dewgong L54...` (kv with long value, possibly prose),
  `Strategy: Lorelei is the first opponent...` (KV-shaped first line, but
  full sentence after the colon → falls through to prose).
- c.kv ≈ 4, c.prose ≈ 6+, total ≈ 10+. c.prose ≥ 0.5 → `prose/plain`.
- ✓ KV-shaped header lines don't pull this into `reference` because the
  bulk of the strategy explanation is prose.

**Q4 JThomas chunk 10 (Pokemon team listing):**
- Lines like `Erika - Celadon City Gym`, `Erika has Victreebel - Lvl. 29`,
  `          Tangela - Lvl. 24`. Short, no terminators, repeating shape.
- c.kv ≈ 0, c.prose ≈ 0, but the short-line / no-terminator fallback fires:
  total ≥ 4, avgLineLen < 60, terminators < 0.2 → `reference/list`. ✓

**Q22 Final Fantasy VII chunk 152 (W-Item Q&A):**
- `Q. How do I do the W-Item duplication trick?\n\nA. This trick only works
  for battle-use items. In battle, choose the W-Item command. ...`
- Two paragraphs. Q line: 1 line, short, has terminator → falls into prose.
  A paragraph: full sentences → `prose/plain`. Both pack as prose.
- ✓ The Q&A format is reliably prose-shaped.

## 5. Type-aware chunk packing

```
packTypeAwareChunks(paragraphs, opts):
  out = []
  buf = { paragraphs: [], type: null, charStart: 0, charEnd: 0,
          length: 0, pendingHeading: null }

  flush():
    if buf empty: return
    chunk = build chunk from buf, content_type = buf.type or 'prose',
            section_heading = buf.pendingHeading
    out.push(chunk)
    buf.reset()

  for p in paragraphs:
    if p.type === 'drop': continue

    if p.type === 'header':
      // Header attaches to NEXT content block. If buf currently empty,
      // remember the heading. If buf non-empty, flush first then remember.
      if buf non-empty: flush()
      buf.pendingHeading = p.heading_text
      continue

    // Type shift: flush before packing the new type
    if buf.type !== null AND buf.type !== p.type
       AND not (buf.type === 'mixed' OR p.type === 'mixed'):
       flush()

    // Size check: if adding p would exceed window, flush and start fresh
    if buf.length + p.length > opts.windowChars AND buf non-empty:
      flush()

    // Oversize paragraph fallback (existing behavior, preserved)
    if p.length > opts.windowChars:
      flush()
      for piece in sentenceSplit(p, windowChars):
        emitSingleChunk(piece, content_type=p.type, heading=buf.pendingHeading)
        buf.pendingHeading = null
      continue

    // Pack
    if buf empty: buf.type = p.type
    buf.append(p)

  flush()
  return out
```

Three places content-type matters:

1. **Type shift = forced flush.** The single most important rule: a `prose`
   paragraph and a `reference` paragraph never share a chunk, regardless of
   how short either one is. This is what fixes Q7 KoritheMan: prose preamble
   becomes its own chunk; the boss block becomes its own chunk.

2. **`mixed` is a sink type.** A pre-classified `mixed` paragraph can pack
   into either neighbor's buffer. Avoids forcing tiny-chunk emissions when
   the classifier wasn't sure.

3. **Headers attach forward.** Banner/section-name lines that appear
   between two content blocks ride along on the *next* chunk's
   `section_heading` field. They never become standalone chunks.

### Overlap

Overlap stays at `chunkOverlapTokens` (default 50) but **only within
matching content_type**. A new `reference` chunk does not get a `prose`
tail-overlap and vice versa. Mixed-type overlap dilutes the new chunk's
embedding signal — which is the very thing this rework is trying to clean
up.

```
prevTail = (lastChunk?.content_type === currentChunk.content_type)
             ? lastChunk.tailOverlap
             : ''
```

## 6. The `mixed` tag

A chunk emits `content_type: 'mixed'` when:

- A paragraph itself classified as `mixed` (no class hit ≥ 50%), AND
- It became its own chunk (didn't pack with a stronger-typed neighbor).

In practice this should be uncommon — most paragraphs cleanly fall in one
class. `mixed` is the escape hatch for cases the classifier doesn't
confidently handle. Retrieval can leave them at neutral weight; this
prevents over-aggressive demotion of borderline content (e.g., a guide
section that genuinely interleaves narrative + 1–2 KV lookup lines).

## 7. Knobs

The classifier's hot paths (`classifyLine`, `classifyParagraph`) are pure
functions with no I/O — adjusting any of the thresholds in §8 is a
unit-test change plus a re-index. Schema-side, `chunks.content_type`
defaults to `'prose'`, so any chunks already on disk from before this
chunker existed read as prose at neutral weight rather than being
retroactively demoted.

## 8. Proposed thresholds (initial values, calibrated against samples)

| Knob | Initial value | Source | Tunable later? |
|---|---|---|---|
| Frame-strip start ratio | 0.8 | A2 prose & B2 tables both ≥ 95% in samples | yes |
| Frame-strip end ratio | 0.8 | Same | yes |
| Divider distinct chars | ≤ 3 | All sampled dividers use ≤ 2 distinct chars | yes |
| KV value max length | 50 chars | "Strategy: ..." values exceed this; HP/Att values don't | yes |
| KV: gate w/o terminator | required | Distinguishes labeled-prose from labeled-stat | yes |
| Versionlog ratio | 0.5 | All sampled changelogs ≥ 90% versionlog lines | yes |
| TOC ratio | 0.5 | All sampled TOCs ≥ 80% toc lines | yes |
| KV ratio for `reference` | 0.5 | All sampled stat blocks ≥ 90% kv lines | yes |
| KV+name ratio for list | 0.7 | Charm FAQ ≈ 100% kv+name | yes |
| List fallback: avg line len | 60 | Pokemon listings, formation tables all ≤ 50 | yes |
| List fallback: terminator fraction | < 0.2 | Stat lists rarely have any | yes |
| Name line max words | 5 | "Lavos Spawn" = 2; full sentences fail this | no |
| Header line max chars | 60 | Banner labels short by convention | yes |
| Prose ratio | 0.5 | Conservative — pushes ambiguous to `mixed` | yes |

These values are not sacred. Adjusting any of them is a unit-test change
plus a re-index; the bench in `tests/benchmarks/rag-accuracy.test.ts` is
the load-bearing signal for whether a threshold change helps or hurts.

## 9. What this design does NOT do

- Does NOT change `RetrievalService` scoring. New chunks are smaller-and-
  cleaner-but-the-same-fan-out; ranking still uses RRF over vec/FTS/title.
- Does NOT change the synthesis prompt. Even with `content_type` available,
  the existing prompt should ground better simply because chunks are less
  contaminated.
- Does NOT add any new external dependency. No NLP library, no external
  classifier — just regex and counters.
- Does NOT delete reference content. Stat blocks and TOCs become their own
  chunks, tagged. They remain queryable.
- Does NOT touch the existing oversize-paragraph fallback (sentence-split).
  That path inherits the parent paragraph's content_type.

## 10. Settled design choices

- **`section_heading` is persisted.** Computing on read would mean
  re-deriving from paragraph offsets every retrieval, which is more
  expensive than a single column.
- **`mixed` is kept as a third class.** Pushing borderline cases into a
  fence-sit class is safer than 50/50 misclassifying them as prose or
  reference.
- **Type-shift flush fires only on `prose ↔ reference` transitions, not on
  any `mixed` transition.** `mixed` is a sink; flushing around it would
  just produce more tiny chunks. Keeping the rule narrow keeps the
  heuristic mild.
