# SYNTH_DEBUG

Working notes on synthesis-side failures. Retrieval-side findings live in [RETRIEVAL_DEBUG.md](RETRIEVAL_DEBUG.md).

**Critical caveat:** synth quality is meaningless to measure on questions where retrieval is broken — if the right strategy chunks aren't in the cited 8, the synth has nothing to ground on and has to either refuse or hallucinate. Until [Retrieval Bug 1 (game-match flood)](RETRIEVAL_DEBUG.md#bug-1--game-match-flood-pathology-most-critical) is fixed, every "synth refused on a well-documented topic" failure is *probably* a retrieval failure being passed up the stack.

## Pipeline (verified 2026-05-05)

`SynthesisService.synthesize()` builds a prompt:

```
You are a video game guide assistant. Answer the user's question using ONLY the provided excerpts. Rules:
1. Use only information from the excerpts. Do not use your training data.
2. Cite each fact with the excerpt number in brackets: [1], [2], or [1,3].
3. If the excerpts do not contain the answer, reply EXACTLY this sentence and nothing else: I don't have that information in the available guides.
4. When the question is procedural ("how do I…"), give every step the excerpts contain — exact item names, locations, level numbers, button inputs, prerequisites, stat thresholds, and named characters. Do not omit detail to be brief; a thorough answer is better than a short one.
5. When the excerpts contain a labelled section (e.g. "Boss Strategies", "Walkthrough — Aquaria Towers"), name the section in your answer so the reader can find it in the source guide.
6. If the excerpts only partially cover the question, answer what they cover and state explicitly which part is missing rather than refusing the whole question.
7. Do not invent details that are not in the excerpts.

Excerpts:
[1] (from "<guide_title>"): <chunk_text>
[2] (from "..."): ...
...

Question: <question>

Answer:
```

Calls Ollama `/api/generate` with `temperature=0.2`, `num_predict=1500`, model from `SYNTHESIS_MODEL` env (production currently `granite4`; CLAUDE.md is stale and says `qwen3:1.7b`).

Output is post-processed: `stripInvalidCitations` removes `[N]` markers where N is outside `[1..maxIndex]`. The "no_answer" sentinel detection is an exact-string startsWith check.

### What the citation system does NOT do

`stripInvalidCitations` only validates that index N is in range. It does NOT:
- Verify the cited chunk contains a fact that supports the surrounding sentence.
- Check that the citation pattern (e.g. `[7]` next to a claim) is plausible given chunk 7's content.
- Penalize the synth for emitting `[N]` next to fabrications.

This is the structural reason the model can invent "Cloud starts with Fairy Cane [1]" with full citation discipline — `[1]` IS a real chunk index, so the post-processor leaves it alone. The wrong-game content is upstream (retrieval surfaced Atelier Iris chunks for the FF7 question).

## Failure modes observed

### A. Citation-backed hallucination

The model fabricates entities and attaches plausible-looking citations. Confirmed instances from the bench:

- **"What weapon does Cloud start with?"** → "Cloud starts with Fairy Cane [1]" (later "Blaster"). Both wrong (correct: Buster Sword). The model parroted whichever wrong-game chunk was cited as [1] (Atelier Iris's Norn → Fairy Cane; "Start Up 2000" → Blaster).
- **"Who is Solid Snake's father?"** → "Solid Snake's father is George Washington [7]". Looking at chunk 7 of that run's citations: `"...Solidus found himself at the feet of a statue of the father of the country, George Washington."` The model lexically matched `father` + `George Washington` in adjacent text and combined them. The real answer (Big Boss / Naked Snake) isn't in the top-8 chunks despite being abundant in the MGS corpus — game-match flood (Retrieval Bug 1) pinned the citations to one guide's structural chunks.
- **"How do I beat Sephiroth in Final Fantasy VII?"** → invented items ("Plasma Blade", "Maiden Who Travels the Planet" as a damage item rather than a section title), invented mechanics (`"Sadness" element` as offensive). The chunk content actually says these in different contexts ("Maiden Who Travels the Planet" is a fan-fiction reference; "Sadness" is a status effect that *increases* defense but the chunk lists it under a "VUL" column for *some* enemies).
- **"How many Triforce shards are in Wind Waker?"** → "There are three" (correct: 8). One run had `[2]` citing actual chart text that mentions chart #1, #2, #3 — model counted instances of "Chart #N" in the visible chunk and reported that as the shard count.
- **"How many stars are in Super Mario 64?"** → "25 stars" (correct: 120). Different chunk in the citation list mentioned "25" in some other context; model picked it up.
- **"How do I beat the final boss in Tetris?"** (trick) → fabricated "Tetris for NES" as the final boss with strategy involving "Rushed Tetris pieces". Tetris has no boss; the model spun a procedure from Tetris DS UI options chunks.

The pattern: when a chunk contains a number, item name, or proper noun semantically *near* the question topic, the model latches on regardless of whether the chunk's surrounding sentence supports the claim. The citation looks correct because the index is in range and the cited chunk does contain the surfaced word — just not in a way that answers the question.

### B. Refusal despite good retrieval (mostly turned out to be C)

Pre-prompt-fix: 14/24 specific questions had `recallHit=true` and `no_answer=true` simultaneously. Post-prompt-fix the rate halved. **However**: many of the remaining refusals are not "synth being too cautious", they're "synth was given TOC chunks for the question and correctly couldn't answer from them" (Retrieval Bug 1, game-match flood). E.g., Krauser RE4: top 8 are all the same guide's character lists; Lavos: top 8 are a Spanish-language guide's first 8 chunks (overview/character bios).

Once retrieval is fixed, expect the refusal rate on these to drop further. The remaining true synth refusals would be the ones to investigate.

### C. Wrong-game disambiguation on ambiguous queries

- **"How do I learn Ultima?"** → interpreted as Ultima Online and emitted skill-system steps that don't even match UO accurately ("rockets / power armor / tri-lithiums" sounds like Fallout). User likely meant the FF spell.
- **"What's the best class in Diablo?"** (pre-1gram-experiment) → answered with FF8 GF junction abilities because retrieval pulled FF8 chunks, not Diablo.

The synth has no mechanism to detect ambiguity in the question and ask for clarification — the prompt is optimized for committing to an answer or refusing. Adding a clarification path would need both prompt changes and an API change (response shape becomes a discriminated union of `answer | clarification_needed`).

### D. Mid-response self-contradiction / hedge

- **D2 dupe glitch**: model produces a confident multi-paragraph answer and then ends with "I don't have that information in the available guides." This breaks the no_answer sentinel detection (the sentence starts with paragraphs of content, doesn't startsWith the sentinel) and the user gets both: a fabrication AND a disclaimer.
- **OoT Master Sword**: model produces a wrong 7-step procedure (invented "Sword of Kings" item, named Phantom Ganon as "Dodongo") and ends with the no-answer sentence. Again, both worlds.

This is partially a prompt-discipline issue (rule #6 invites partial answers, which the model interprets as license to attempt + hedge) and partially a "no_answer" sentinel design issue — startsWith means the sentinel must appear at position 0 to count, but the model puts it last.

### E. Trick-question handling inconsistent

- "Triforce in Ocarina of Time" → handled correctly (chunk 16 of the OoT guide literally says "The Triforce does not exist in this game…"; the model parroted that).
- "Secret combo to one-shot Ganon in BotW" → refused safely but didn't correct the false premise.
- "Final boss in Tetris" → fabricated boss content (see failure mode A).

The system has no mechanism for premise-detection — trick questions only get handled correctly when the corpus happens to contain a literal counter-statement.

## Fixes shipped 2026-05-05

### Fix 1 — Prompt rewrite + `num_predict` 500 → 1500

`src/services/SynthesisService.ts`:
- Replaced the `Be concise. Do not invent details.` rule with explicit thoroughness rules (give every step, name items/locations/level numbers/button inputs, name section headings, partial-answers-with-stated-gaps over full refusal).
- Bumped `num_predict` from 500 → 1500 so multi-step answers don't get truncated mid-thought.

**Effect:** synth-answered rate 33.3% → 63.3%. Refusal halved. New side effect: rule #6 + bigger output budget made the model more willing to fabricate from sparse evidence (failure mode A worsened on questions where retrieval was already broken).

## Fixes deferred

### Fix 2 — Synth model bump

CLAUDE.md is stale: it says `SYNTHESIS_MODEL=qwen3:1.7b` but production runs `granite4` (per `docker-compose.yml`). Candidates documented in memory `synth_followups.md`:
- `granite4:medium-h` (~32B MoE) — biggest expected quality jump; 1–3s synth latency.
- `qwen3:4b`, `llama3.1:8b` — non-IBM comparison points.

Won't try until Retrieval Bug 1 is fixed — otherwise we'd be measuring a bigger model fighting bad chunks.

### Fix 3 — Section-aware chunks

Surface section headings in citations: `[N] (from "FF6 Advance" → "Boss Strategies"): ...`. Lets the synth name sections directly in answers and gives it more context for what the chunk is "about". Requires a chunker change, a `chunks.section_heading` column (SCHEMA_VERSION 5 → 6), and an index rebuild. Memo'd in `synth_followups.md`.

### Fix 4 — Citation grounding (post-hoc verification)

After synth output, for each `[N]`, embed the surrounding sentence and check cosine similarity against chunk N's embedding. If similarity is below threshold, strip the citation (signaling the claim is unsupported). Won't catch all hallucinations but catches the brazen ones (e.g. claim "Cloud starts with Fairy Cane" cited against an Atelier Iris chunk — the sentence "Cloud starts with X" embeds far from the chunk's actual content). Cheap to add (one extra embedding round-trip per [N] in the answer). Not yet prototyped.

### Fix 5 — Ambiguity detection / clarification flow

For ambiguous queries (no game named, common spell/item names), have the synth emit a structured "did you mean game A or game B?" response when the cited chunks are split across multiple games. Requires API change to the response shape and corresponding UI changes. Not yet scoped.

### Fix 6 — No-answer sentinel detection robustness

Either:
- Detect the sentinel at end-of-text as well as start (failure mode D), and treat as full refusal regardless of position.
- Or change the sentinel to a structured field the model emits as the FIRST thing (e.g. `<no_answer/>` line at top), and instruct rule #3 accordingly. Cleaner but needs prompt rework.

## How to evaluate synth in isolation

Until retrieval is clean, partition the bench into two buckets:

1. **Retrieval-correct subset:** questions where `recallHit=true` AND the cited chunks include strategy content (not just TOC). The bench can't currently distinguish "guide cited" from "useful chunks cited" — a follow-up would inspect citations and exclude TOC-only sets. Synth metrics on this subset are meaningful.
2. **Retrieval-broken subset:** everything else. Synth metrics here are noise.

The bench summary already reports `recall@K`, `synth answered`, and `fully passed` separately. Adding a `useful chunks cited` metric (heuristic: at least one chunk's content includes a question keyword OR is >70% alphanumeric AND >50 words of prose) would tighten the synth-only numerator.

## Bench history

See RETRIEVAL_DEBUG.md for retrieval rates. Synth-side:

| Date | Synth answered | Fully passed | Notes |
|---|---|---|---|
| 2026-05-05 (pre-prompt fix) | 33.3% | 30.0% | Original "be concise" prompt, num_predict=500 |
| 2026-05-05 (post-prompt fix) | 63.3% | 33.3% | New prompt + num_predict=1500. Synth refusals halved; new fabrication risk on broken-retrieval questions. |
