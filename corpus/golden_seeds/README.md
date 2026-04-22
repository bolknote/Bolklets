# Golden seed dialogue bank

Per-character, per-`(tone, act)` cell curated lines used as:

1. Higher-weight training rows in `tools/train_dialog.py` (alongside
   `corpus/dialog_domain_lines.tsv`), so the production Markov model
   shifts toward in-character openers and body words.
2. A future retrieval bank (see `README.md` root doc — "LLM distillation"
   track), where the runtime chooses lines by nearest-neighbour over
   embedded `(tone, act, persona, previous-line)` context.

## File format

One TSV per character at `corpus/golden_seeds/<name>.tsv` with four
tab-separated columns, matching `dialog_domain_lines.tsv`:

```
tone<TAB>act<TAB>weight<TAB>line
```

- `tone` — one of `calm`, `tense`, `shaken` (same set as `TONE_NAMES`
  in `web/js/markov.js` and `TONE_LEX` in `tools/train_dialog.py`).
- `act` — one of `greet`, `farewell`, `chatter`, `ask`, `answer`,
  `refuse`, `agree`, `warn`. This is a slight reshuffling of the
  ad-hoc act names already in `dialog_domain_lines.tsv` (`greeting`
  → `greet`, `warning` → `warn`, `calm`/`question`/`promise` folded
  into `chatter`/`ask`/`agree`).
- `weight` — integer 1..9. Golden seeds ship at `6`, one above the
  highest `dialog_domain_lines.tsv` row (`5-6`), to bias Markov toward
  character-flavoured openers without dominating the Cornell corpus.
- `line` — one line of dialogue, 3..12 words, no names, no honorifics,
  no archaisms (`verily`, `hark`, `thou`), no self-introductions, no
  stutter loops, ASCII punctuation only.

## Generation rules (applied to every cell)

- 40 lines per `(tone, act)` cell → 24 cells × 40 = 960 lines per
  character at golden tier.
- Register honours per-character `LEX_BY_NAME` / `VOICE_BY_NAME` from
  `web/js/dialog.js`: witch uses `shadow / cauldron / spell / moon /
  charm / spirits / herbs`, viking would use `axe / mead / raid`, etc.
- Tone honours `TONE_LEX` from `web/js/markov.js`: `tense` lines use
  watch / careful / stay / eyes / hold vocabulary; `shaken` lines use
  barely / alive / breathe / rattled / still / trembling.
- Act honours structure: `ask` ends in `?`, `agree` / `refuse` open
  with an affirmative / negative, `warn` opens with an imperative.
- Roughly 60% of each cell is character-flavoured (LEX hits); ~40%
  is plain-friendly within the register so retrieval has neutral
  fallbacks when the previous line is off-topic for the character.

## Provenance

Authored directly by the Cursor agent during the LLM-distillation
track (see "Why Markov and not something else?" in the root README).
The cheaper bulk tier (`~12k` lines via Qwen3-30B-A3B or similar) is
expected to use this file as its few-shot exemplars.
