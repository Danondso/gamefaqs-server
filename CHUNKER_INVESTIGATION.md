# Chunker investigation report

**Phase 1 of the chunker rework.** This report inventories how the current
chunker produces chunks, what content-type patterns appear in the GameFAQs
corpus, and which patterns drive the bench failures we want the rework to
address. It is the design input for Phase 2 (heuristic design) and is referenced
by Phase 3 (implementation) and Phase 5 (validation).

All chunk excerpts below are taken verbatim from the most recent bench-qa.txt
(2026-05-06 run) — the chunks that were actually returned for each query. Where
a chunk excerpt is truncated, it is truncated at a paragraph boundary in the
quoted content; the surrounding citation context is preserved.

## 1. How the current chunker works

`src/services/Chunker.ts` is a pure-paragraph greedy packer:

1. Split the guide into paragraphs (`\n{2,}`).
2. Drop paragraphs that are >80 % non-alphanumeric (the "ASCII art filter").
3. Greedily pack remaining paragraphs into ~`chunkSizeTokens`-token windows
   (default 400 tokens ≈ 1600 chars). If a paragraph exceeds the window, fall
   back to sentence-splitting on `.!?\n`.
4. Apply an overlap of `chunkOverlapTokens` chars from the previous chunk's tail.

There are **no signals about content type**: a paragraph is a paragraph,
whether it is narrative prose, an HP/Att stat block, a multi-line Q&A,
a table-of-contents block, or a banner. The 80 % non-alnum filter is too
permissive for the dense ASCII tables this corpus is full of: lines like
`|  Attack 1: <Sephiroth Shock>    Target: One Opponent      Can't Cover      |`
contain enough alphanumerics ("Attack", "Sephiroth", "Shock", "One", "Opponent",
"Can", "Cover") to slip through unchallenged. Once a stat-block paragraph is
admitted, it gets greedy-packed alongside more stat-block paragraphs — the
pack boundary is character count, not content shift — and the resulting chunk
is a contiguous wall of structured table rows with no narrative.

Two consequences:

- **Stat tables drown out strategy prose.** When a guide has 50+ paragraphs
  of stat tables clustered around a single 5-paragraph strategy section, the
  chunker emits ~12 stat-table chunks and 1 strategy chunk. All 13 chunks
  have similar embeddings (game name + boss name dominates) and similar BM25
  scores (boss name + status/element/attack tokens). Retrieval fans out
  across all of them; only one carries the actual answer.
- **Boilerplate is treated as content.** Tables of contents, version-history
  changelogs, ASCII title banners, and FAQ author bios get packed into chunks
  the same way strategy text does. They occupy the early chunk indices of
  most guides (chunk 0–10 of every guide is almost always boilerplate),
  which means a hard-game-match guide-id boost surfaces them on top.

## 2. Content-type patterns observed in the corpus

The corpus in `gamefaqs.db` is messy text dumps. After reading ~30 chunks
across the failing/passing bench queries, four content types account for
nearly all chunks:

### 2.A Strategy prose (the chunks we want to retrieve)

Sentence-length lines, full subject-verb structure, second-person address,
imperative verbs, and conditionals. Two sub-shapes:

**(A1) Plain prose** — most common in passing bench queries.

> Excerpt — chunk 59 of `Resident Evil 4 — Adnan Javed` (Q14 RE4 church, passes):
> ```
> Once you've taken all this, climb up to the ladder up the 2nd
> floor and when ready, jump on the chandelier. Once it starts
> to swing, make sure you dont jump before it actually reaches
> the top of its swing on the other side, you'll land near a small
> puzzle console. This is actually a panel with 3 different colors
> on it, you have to use the panel to rotate the colors until the
> pattern matches the one in the middle part of the console.
>
> Rotate the red one twice
> Rotate the green one three times
> Rotate the blue one once.
> ```

**(A2) Bordered prose** — strategy paragraphs wrapped in `| ... |` ASCII
frames so that line ends with a fixed-position `|`. The narrative is intact;
the borders are decoration. The most-correct Sephiroth strategy chunk is in
this shape:

> Excerpt — chunk 2085 of `Final Fantasy VII — DynamixDJ` (Q1 Sephiroth, the
> single chunk that contains the actual answer):
> ```
> | Cloud can remain idle (or use Defend), in which case Sephiroth will       |
> |  attack Cloud with an attack that will deplete his HP to critical, after- |
> |  which Sephiroth's AI Script will take control of Cloud and have him use  |
> |  "Attack" on Sephiroth, triggering the counter script and ending the      |
> |  battle. ...                                                              |
> | The second way is to just use Omnislash, as intended, and watch Cloud     |
> |  knock Sephiroth down once-and-for-all. Congratulations! ...              |
> ```

(A2) is critical: classifying the leading `|` and trailing `|` as "ASCII art"
would throw the whole chunk away. The chunker must recognize this is *prose
with a frame* and unwrap it (or at least not penalize it).

### 2.B Reference tables (the chunks we want to demote)

Dense, structured, key-value or position-position layouts. Almost every
line ends in a literal value. Three sub-shapes recur:

**(B1) Boxed stat blocks** — boss/enemy attribute dumps inside an ASCII frame.

> Excerpt — chunk 264 of `Chrono Trigger — KoritheMan` (Q7 Lavos):
> ```
>  ------------------------------------------------------------------
>  |          Boss Battle :                                         |
>  |    Center Bit/Lavos Core/Left Bit                              |
>  |          HP: (Center Bit) 10000                                |
>  |          HP: (Lavos Core) 30000                                |
>  |          HP: (Left Bit) 2000                                   |
>  |          Attack: (Center Bit) 100                              |
>  |          ...                                                   |
>  ```

Pattern: `|` border, then `<Stat>: <value>`, padded to a fixed column, then
`|`. Lines of identical structure repeat for 15–30 rows. Almost no narrative
verb forms appear.

**(B2) Pipe-grid attack/element/AI tables** — DynamixDJ's signature format.

> Excerpt — chunk 1976 of `Final Fantasy VII — DynamixDJ` (Q1 Sephiroth, table noise):
> ```
> |>~~~~~~~~~~~~~~~~~~~~~~~~~~~~~o~~~~~~~~~~~~~~~~~~~~~o~o~~~~~~~~~~~~~~~~~~~~<|
> |  MAPS:                                 FORMATION ID: |   LOOKALIKES:       |
> |                                                      |                     |
> | Planet's Core Sephiroth Encounter               #916 |  Bizarro-Sephiroth  |
> | ...                                                                        |
> |  Attack 1: <Sephiroth Shock>    Target: One Opponent      Can't Cover      |
> |  [3AC]       Physical          Element: Cut                                |
> |  [3B0]                            Att%: 100                                |
> ```

Marker density: `|` at column 0 AND at column ~78, internal `~`/`o` border
runs, hex IDs in brackets (`[3AC]`, `[3B0]`), labels followed by colons
(`Att%:`, `Power:`, `Element:`), and content fields padded to fixed columns.
All 6 of the top 8 chunks for Q1 are this shape.

**(B3) Flat list-of-entries** — alphabetical reference like the Charm FAQ.

> Excerpt — chunks 2–4 of `Chrono Trigger — AdrenalineSL` (Q7 Lavos, surfaces
> wrongly because "Lavos Spawn" is in the list):
> ```
> Lavos Spawn
>    Charm: Elixir
>    Location: Death Peak (2300 AD)
>
> Lavos Spawn
>    Charm: Safe Helm (Shell), Haste Helmet (Head)
>    Location: Black Omen
>
> Lizardactyl
>    Charm: HyperEther
>    Location: Giant's Claw (600 AD)
> ```

Pattern: 3-line entries (`<Name>` → 2 indented `<Field>: <value>` lines)
separated by a blank line. No paragraphs longer than 1 sentence. Dozens of
entries pack into one ~1600-char chunk.

### 2.C Tables of contents / changelogs (the chunks we want to drop or strongly demote)

Pure boilerplate that occupies the early chunks of nearly every guide.

**(C1) Section TOC with dot leaders or numeric prefixes**

> Excerpt — chunk 0 of `Resident Evil 4 — Lord_Pignea` (Q5 Krauser, Q14 RE4 church
> — surfaces in the top 8 for both because of `game_id` matching):
> ```
> 1 - Changelog
> 2 - Controles
>   2.1 - Gamecube
>   2.2 - Playstation 2
>   2.3 - Ashley
> 3 - Dicas
> 4 - Detonado
>   4.1 - Capítulo 1
>       4.1.1 - Capítulo 1 - 1
>       4.1.2 - Capítulo 1 - 2
>       ...
> ```

> Excerpt — chunk 1 of `Resident Evil 4 — Joe Zakutny` (Q5 Krauser):
> ```
> About This Guide ........................................................ REH002
> About The Author ........................................................ REH003
> Definitions ............................................................. REH004
> Characters .............................................................. REH005
> Enemies ................................................................. REH006
> ...
> ```

Pattern: Lines mostly composed of numeric/punctuation prefixes, indented
hierarchical numbering, and dot-leader runs (`...` → reference codes).
Crucially, these chunks contain almost no full sentences.

**(C2) Version history changelogs**

> Excerpt — chunk 2 of `Resident Evil 4 — Lord_Pignea` (also chunk 1 of
> `Joe Zakutny`):
> ```
> Versão 0.01 - 18/04/2005 - Primeira versão.
> Versão 0.18 - 21/04/2005 - Acabei o Capítulo 1-3. Comecei o 2-1.
> Versão 0.24 - 22/04/2005 - Acabei o Capítulo 2-1. ...
> ...
> ```

Each line is `<Version> <Date> <one-line note>`. Lots of dates, version
numbers, and proper-noun section names; almost no second-person prose.

### 2.D Section headers and ASCII banners (decoration; not standalone chunk content)

These are short — 1 to 8 lines — and currently the >80 %-non-alnum filter
catches some of them (the all-`=` and all-`~` runs). Headers that include a
section name slip through and get packed into adjacent prose, attaching to
the *previous* chunk rather than the *following* content.

> Excerpt — `Pokemon Red Version — Mike Meevasin %` (Q4 Elite Four, Q21 missingno):
> ```
> %%%Indigo Plateau%%%%%%%%%%%%%%%%%%%%%%%%%
>
>      Entering the building above the Indigo Plateau. ...
> ```

> Excerpt — `Final Fantasy VII` (Q22 W-Item, Q24 dupe):
> ```
> mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm
>  \ \/ / O~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|Section XIX: Hints & Tricks|/ /\ \
>  _\  /_ |                                  ¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯~~~~~~/  \¯
> ```

Pattern: ASCII-art frames carrying a section label. The label is the
useful bit; the surrounding decoration is noise.

> Excerpt — `Chrono Trigger — KoritheMan` (Q7 Lavos):
> ```
>  ------------------------------------------------------------------
>  |          Boss Battle :                                         |
>  |    Center Bit/Lavos Core/Left Bit                              |
> ```

The `------` divider is a header marker; the `|          Boss Battle :` line
is a label that should attach to the table that follows. Currently it's part
of the same packed paragraph as the table.

## 3. Why the failing bench queries fail (chunk-level diagnosis)

### Q1 Sephiroth — strategy buried under table noise

Top 8 chunks returned (chunk indices in `Final Fantasy VII — DynamixDJ`,
unless noted):

| Rank | chunk_idx | content type | useful for the answer |
|------|-----------|--------------|-----------------------|
| 0    | 2000      | (B2) attack/element pipe-grid | no |
| 1    | 1976      | (B2) attack/element pipe-grid | no |
| 2    | 2026      | (B2) attack/element pipe-grid | no |
| 3    | 2048      | (B2) attack/element pipe-grid | no |
| 4    | 1948      | (B2) attack/element pipe-grid | no |
| 5    | 1939      | (B2) AI script pipe-grid     | no |
| 6    | 2085      | **(A2) bordered strategy prose** | **yes** |
| 7    | 1930      | (B2) attack/element pipe-grid | no |

7 of 8 chunks are pure pipe-grid stat data. Synthesis on Qwen3 manages to
ground on chunk 6 anyway, but the answer mentions Formation IDs from the
table noise even though they're irrelevant. With a smaller synth model
(Granite4 in the prior run) the model confabulates from the stat block.

### Q5 Krauser — actual strategy not chunked, table-of-contents and version history fill the slate

Top 8 chunks include 1 paragraph of Krauser lore (chunk 289 of `Muchitsujo`)
and 7 chunks of `Lord_Pignea` Portuguese-guide TOC + changelog (C1 + C2).
The synth refuses ("don't have a confident answer") because no chunk
contains a Krauser fight strategy — the closest is a backstory paragraph.

The C1/C2 chunks surface high here because of game-id matching: every
Lord_Pignea chunk is for `Resident Evil 4 (GameCube)`, the matched game,
and the rare-token filter sees lots of game-name tokens in those chunks
plus filler. With those chunks demoted, the slate would fill from real
prose chunks instead of TOC/changelog content.

### Q7 Lavos — Charm FAQ surfaces wrongly, real strategy is mixed with a stat block

Top 8 chunks:
- chunk 242, 264 of `KoritheMan`: mixed (A1 prose + B1 boss block in the same
  packed chunk). Chunk 264 is the chunk that should be retrieved — it has
  the actual "final battle with Lavos will commence" sentence — but it's
  packed alongside a B1 block, so half the embedding signal is
  "Center Bit / 10000 / 30000 / 2000 / 100" rather than the strategy verb.
- chunks 0, 1, 2, 3, 4, 5 of `AdrenalineSL`: Charm FAQ (B3). "Lavos Spawn"
  appears as an entry name in this list, so BM25 fires on it heavily.

If `KoritheMan` chunk 264 had been split with the boss-block as its own
chunk and the strategy prose as its own chunk, the strategy chunk would
embed cleanly on the Lavos question. And if the Charm FAQ entries were
tagged as reference data, they would be demoted for "how do I beat" queries.

### Q4 Elite Four — passes, but with mixed chunks

Top 8 chunks include `KoritheMan` chunk 122 (good prose strategy from
the same author), `Mike Meevasin` chunk 29 (mixed: prose entry to Indigo
Plateau followed by a Lorelei stat block), and `JThomas` chunk 10 (almost
pure stat listing of every gym leader's team).

This passes today because chunk 122 carries enough strategy prose that the
synth answers cleanly. But ~3 of the top 8 are reference-only and waste
context tokens; the answer would tighten if those were demoted.

### Q14 RE4 church, Q22 W-Item — pass cleanly

Both queries return a single short prose chunk that carries the entire
answer (Q14 chunk 59, Q22 chunk 152). The strategy fits inside a 400-token
window without surrounding stat-block contamination. There is nothing
structurally special about these — they are A1 prose throughout — they
just happen to be in passages that don't have stat blocks adjacent.

## 4. Marker density: numeric signals to design heuristics around

Rough character-class signals computed by eye on the sampled chunks:

| Content type | leading `\|` lines | `:` density | full-stop sentences | line length |
|---|---|---|---|---|
| (A1) Plain prose | rare | low (~1/line) | high (≥1 per 3 lines) | 50–80 |
| (A2) Bordered prose | nearly every line | low (~1/line) | high | 70–80 (uniform) |
| (B1) Boxed stat block | nearly every line | high (≥1/line) | none | 65–80 (uniform) |
| (B2) Pipe-grid table | nearly every line | very high | none | 78 (uniform) |
| (B3) Flat list-of-entries | rare | high (≥1/line, sometimes 2) | none | 25–50 |
| (C1) TOC | rare | rare | none | varies; many lines start with digits |
| (C2) Changelog | rare | rare (after version) | optional | 60–80 |
| (D)  Header / banner | sometimes | rare | rare | 10–80 (very irregular) |

What separates A2 from B1/B2 (both have leading `|`):

- **Mean alphabetic-content per line.** B-shape tables have <30 % alphabetic
  content per line (lots of padding spaces and structural symbols); A2 prose
  has 50–70 %.
- **Sentence-terminator density.** A2 has full-stop terminators inside the
  frame; B-shape tables don't.
- **Repetition of `<Label>:` patterns.** B1 has many lines of the form
  `<spaces>Label: value` packed identically; A2 doesn't.

What separates B3 from A1 (both have no `|` borders):

- **Line length distribution.** B3 lines are nearly all short (15–40 chars)
  and indented; A1 lines wrap at ~75 chars and are continuous.
- **Blank-line cadence.** B3 has a blank line every 3–4 lines (entry
  separator); A1 prose has blank lines every 6–10 lines (paragraph break).
- **Repeated short label tokens.** B3 has the same labels (`Charm:`,
  `Location:`) on most lines; A1 has lexical variety.

What separates C1 from anything else:

- **Lines starting with digits or numeric prefixes** (`1 - `, `4.1.1 -`,
  `[1]`).
- **Dot-leader runs** (`....... REH002`, `..............`).

These are the signals to design Phase 2 heuristics around.

## 5. The "reference vs prose" decision is what unblocks the failing queries

Rough estimate of what would happen with each content-type tag in retrieval
hands (NB: retrieval scoring is *not* changing in Phase 3 — these notes are
forward-looking for a later phase):

- Tagging B-shape (B1, B2, B3) chunks as `reference` and demoting them on
  "how do I beat / how do I solve" queries fixes Q1, would clean up Q4, and
  helps Q7 if the Charm FAQ is correctly tagged as reference.
- Tagging C-shape (C1, C2) chunks as `boilerplate` and demoting them
  unconditionally fixes Q5 (where they fill 6 of 8 slots).
- Splitting boundary-mixed chunks (the Q7 KoritheMan case where prose +
  boss-block are packed together) fixes Q7 even before any retrieval-side
  change.

The chunker doesn't change retrieval scoring directly, but **it determines
the chunk that retrieval can score**. Splitting cleanly is a precondition;
tagging is what later retrieval/synthesis layers can use.

## 6. Other observations worth recording

- The current ASCII-art filter (>80 % non-alnum) **does not catch B-shape
  tables**: the alnum density of a stat-row-with-padding line is ~25–35 %,
  which is comfortably above the 20 % alnum threshold. The filter only
  catches pure dividers (`====`, `~~~~`) and pure banner art.
- A guide's first ~10 chunks are dominated by C-shape boilerplate. With
  game-id matching giving every chunk in a matched-game guide a uniform
  guide-id boost, those early chunks frequently outscore actual content
  chunks. (Cf. the Lord_Pignea Portuguese guide showing up 6× in Q5's top 8.)
- "Bordered prose" (A2) is unique to certain authors — DynamixDJ, KoritheMan,
  some Final Fantasy guides. It's a stylistic decoration; the chunker
  must preserve the prose underneath.
- The `Q. <question>\n\nA. <answer>` Q&A format (Q22 chunk 152) is reliably
  prose-shaped — the answers are full sentences. No special handling needed.
- Author-written changelog entries occasionally carry one full sentence
  ("Acabei o Capítulo 5-1") that's prose-ish but useless. C2 detection
  should not require all lines to be content-free — it just needs the
  line shape to be `<Version> <Date> <text>`.
- Schema is at v10; adding `chunks.content_type` requires a v11 migration.
  The migration must be reversible (Phase 5 may need to revert).

## 7. Going into Phase 2 with this

Heuristic targets for Phase 2:

1. **Frame unwrap**: detect leading-`|`/trailing-`|` "bordered" content and
   unwrap to inner text *before* classifying. (A2 prose and B1/B2 tables
   both have `|`; the inner text is what differentiates them.)
2. **Per-line content classification**: tag each line as `prose`, `kv`,
   `divider`, `header`, `toc`, or `versionlog`. Aggregate up to paragraph
   and chunk level.
3. **Block-level boundaries**: don't pack a `prose`-majority block with
   a `kv`-majority block. Splitting on content-type shift is the boundary
   the current chunker is missing.
4. **Header attachment**: a `header`-tagged short paragraph attaches to the
   *next* block, not the previous one.
5. **Chunk tagging**: each emitted chunk carries `content_type`:
   `prose | reference | header | mixed`. Do not over-engineer the taxonomy.
6. **Reversibility**: the new chunker should be feature-flagged for at
   least the small-corpus eyeball phase, so we can A/B before a full re-index.

Numeric guardrails based on the 400-token window:

- Don't pack across a content-type shift even if the resulting chunk is
  small. A 200-token prose chunk + a 200-token kv chunk are better than a
  400-token mixed chunk.
- An oversize prose section (> 400 tokens) splits at paragraph boundaries
  before sentence boundaries (current chunker does this for sentences but
  not for content-type prose blocks specifically).

This document is the hand-off to Phase 2.
