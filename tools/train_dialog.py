"""
Trains the word-level Markov dialogue model and writes it to
`dialog_model.json` for the browser to consume.

Why Markov? The task asks for locally trainable dialogue without a big
neural model.  At word-level n=2 a Markov chain is just a table of
"after these two tokens, here are the next-token probabilities", which
fits happily in a few hundred KB of JSON and runs instantly in the
browser.  The output looks coherent for a line or two — exactly what
we need for the little bubbles above the characters' heads.

Why these knobs?  The defaults below (`--order 2`, `--min-count 2`,
`--max-nexts 64`, `--max-starts 8000`, `--canned-weight 5`,
`--rare-drop 5`, in-world TSV overlay, targeted proper-noun filters,
per-start tone tagging, weighted starts) are the current production
recipe after the radical metrics pass: keep the compact bigram model,
but push quality hard with a curated domain layer, stronger trainer-side
junk rejection, wider transition/start caps, and the cleaner "guarded"
filter recipe that beat both the richer bigram and the higher-order
hybrid branches on overall audit quality.

Corpus
------
Cornell Movie-Dialogs Corpus (Danescu-Niculescu-Mizil, 2011): ~10 MB
zipped, ~300k utterances of real film dialogue.  We cache it locally
under `./corpus/` so we don't re-download on every run.

Output JSON shape:

    {
      "order":                  2,
      "starts":                 [[w1, w2], ...],
      "start_weights":          [count, ...],
      "starts_by_tone":         {"calm": [...], "tense": [...], "shaken": [...]},
      "start_weights_by_tone":  {"calm": [...], "tense": [...], "shaken": [...]},
      "trans":                  {"w1 w2": [[w3, count], ...], ...},
      "n_sentences":            int
    }

The runtime in `js/markov.js` reads the per-start weights for sub-
linear (flattened) sampling so the heaviest openers don't dominate
every batch, and reads `starts_by_tone` so the dialog layer can ask
for tense / shaken openers when the scene calls for them.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORPUS_DIR = ROOT / "corpus"
CORPUS_DIR.mkdir(parents=True, exist_ok=True)

ZIP_URL = "https://www.cs.cornell.edu/~cristian/data/cornell_movie_dialogs_corpus.zip"
ZIP_PATH = CORPUS_DIR / "cornell_movie_dialogs_corpus.zip"
LINES_PATH = CORPUS_DIR / "movie_lines.txt"
DOMAIN_LINES_PATH = CORPUS_DIR / "dialog_domain_lines.tsv"
GOLDEN_SEEDS_DIR = CORPUS_DIR / "golden_seeds"
OUT_PATH = ROOT / "build" / "dialog_model.json"
OUT_PATH.parent.mkdir(parents=True, exist_ok=True)


TOKEN_RE = re.compile(r"[A-Za-z']+|[.!?,]")
SENTENCE_END = {".", "!", "?"}

# Movie dialogue is full of `Mr Smith`, `Captain Reynolds`, `Lord
# Vader` etc.  Every one of those is a proper noun the chain has no
# business memorising — it just leaks named characters into the
# bubbles ("the captain weighed in" → "the kringelein weighed in").
# We drop any sentence that touches a title; the corpus is huge so we
# can afford to be greedy here.
TITLES = {"mr", "mrs", "ms", "miss", "sir", "dr", "lord", "lady", "king",
          "queen", "captain", "professor", "mister", "madam"}

# Words that often appear capitalised in the raw corpus for reasons that
# do NOT mean "this is a character name we should ban from the model".
# Used when mining name-like leakage candidates from mid-sentence
# capitalisation patterns.
SAFE_NAMEY = {
    "i", "i'm", "i've", "i'll", "i'd",
    "a", "an", "the", "and", "or", "but", "if", "of", "for", "to",
    "with", "at", "on", "in", "by", "from", "as", "than", "so",
    "he", "she", "it", "we", "you", "they",
    "yes", "no", "okay", "ok", "well", "oh", "ah", "hey", "hi", "hello",
    "god", "good", "right", "look", "listen", "wait", "come", "go",
    "today", "tomorrow", "yesterday", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday", "sunday", "january", "february",
    "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december",
    "mom", "dad", "mama", "papa", "sir", "maam", "doc", "doctor",
}
CAPITALIZED_RE = re.compile(r"[A-Z][A-Za-z']*$")

# Three small lexicons used for per-start tone classification.  Each
# sentence is scored against the lexicons and tagged with whichever
# wins (default `calm`).  The runtime then picks tone-matching
# openers when the scene goes tense / shaken (combat / aftermath).
TONE_LEX = {
    "tense": {
        "watch", "behind", "careful", "stay", "keep", "quiet", "down",
        "above", "around", "moving", "wait", "easy", "ready", "weapons",
        "eyes", "cover", "run", "stop", "hide", "danger", "shh", "shhh",
        "move", "duck", "freeze", "back", "drop", "hurry", "quick",
        "fast", "now", "go", "listen", "look", "hold", "stand",
        "ahead", "behind",
        "weapon", "gun", "knife", "blade", "sword", "shoot", "shot",
        "kill", "killed", "killing", "dead", "die", "dying", "monster",
        "creature", "blood", "bloody", "fight", "fighting", "attack",
        "attacking", "enemy", "enemies", "trouble", "danger", "dangerous",
        "scared", "afraid", "they're", "coming", "incoming",
    },
    "shaken": {
        "almost", "close", "alive", "phew", "lucky", "thank", "safe",
        "rest", "breathe", "breathing", "still", "broken", "hurt",
        "wounded", "barely", "scared", "shaking", "whew", "trembling",
        "okay", "alright", "fine", "made", "survived", "survive",
        "escaped", "escape", "lost", "tired", "weak", "exhausted",
        "blessed", "spared", "lived", "saved", "miraculously",
        "incredible", "unbelievable", "thought", "feared",
        "sorry", "okay", "well", "god", "goodness", "heavens",
        "moment", "second", "minute", "shock", "scare", "frightened",
        "trembled", "hands",
    },
    # `calm` is the default — anything not strongly tense/shaken.
}
TONE_NAMES = ["calm", "tense", "shaken"]

# Per-act sub-chains (v9 act-aware runtime).  Cornell sentences don't
# carry act tags, so we mine the act from a tiny first-word + final-?
# heuristic.  Domain TSV / golden seed records carry their own
# `act_hint` and bypass this function.
ACT_NAMES = (
    "greet", "farewell", "ask", "answer",
    "agree", "refuse", "warn", "chatter",
)

GREET_OPENERS = {
    "hello", "hi", "hey", "welcome", "morning", "afternoon",
    "evening", "greetings", "howdy",
}
FAREWELL_OPENERS = {
    "bye", "farewell", "goodbye", "goodnight", "until",
    "cheerio", "later", "ciao",
}
REFUSE_OPENERS = {
    "no", "not", "never", "sorry", "afraid", "nope",
}
AGREE_OPENERS = {
    "yes", "yeah", "yep", "sure", "okay", "ok", "alright",
    "right", "agreed", "aye", "absolutely", "certainly", "indeed",
}
WARN_OPENERS = {
    "watch", "careful", "mind", "beware", "shh", "shhh", "hush",
    "hold", "stand", "stop", "wait", "duck", "freeze", "drop",
    "cover", "down", "back", "easy", "quiet",
}


def classify_act(tokens):
    """Heuristic dialogue-act classifier. Always returns one of ACT_NAMES."""
    if not tokens:
        return "chatter"
    if tokens[-1] == "?":
        return "ask"
    first = tokens[0]
    if first in GREET_OPENERS:
        return "greet"
    if first in FAREWELL_OPENERS:
        return "farewell"
    if (first == "see" and len(tokens) >= 2
            and tokens[1] in {"you", "ya"}):
        return "farewell"
    if (first == "take" and len(tokens) >= 2 and tokens[1] == "care"):
        return "farewell"
    if first == "good" and len(tokens) >= 2:
        if tokens[1] in {"morning", "afternoon", "evening"}:
            return "greet"
        if tokens[1] in {"night", "bye"}:
            return "farewell"
    if first in REFUSE_OPENERS:
        return "refuse"
    if (first == "i" and len(tokens) >= 2
            and tokens[1] in {"cannot", "can't", "won't", "refuse"}):
        return "refuse"
    if first in AGREE_OPENERS:
        return "agree"
    if (first == "of" and len(tokens) >= 2 and tokens[1] == "course"):
        return "agree"
    if first in WARN_OPENERS:
        return "warn"
    if (first == "do" and len(tokens) >= 2 and tokens[1] == "not"):
        return "warn"
    if first == "don't":
        return "warn"
    return "chatter"


# Hand-crafted prior for next-act given previous act in a two-person
# small-talk turn. Values are unnormalised weights; the runtime samples
# from each row's distribution. Built from a few common discourse
# conventions:
#   * after a question, mostly answers (some refusals/agrees,
#     deliberately few back-to-back questions);
#   * after a greeting, more chatter than another greeting;
#   * after a refuse/agree/warn, conversation moves on to chatter or
#     a tonally-aligned next act.
# The runtime can layer per-character / per-tone overrides on top.
ACT_TRANS_PRIOR = {
    "greet":    {"greet": 1.0, "chatter": 4.0, "ask": 2.0, "agree": 1.0,
                 "warn": 0.5, "answer": 0.3, "refuse": 0.2, "farewell": 0.2},
    "farewell": {"farewell": 3.0, "chatter": 1.0, "agree": 0.5,
                 "answer": 0.3, "ask": 0.2, "refuse": 0.2, "warn": 0.2,
                 "greet": 0.2},
    "ask":      {"answer": 7.0, "agree": 1.5, "refuse": 1.5, "chatter": 1.0,
                 "warn": 0.5, "ask": 0.1, "greet": 0.05, "farewell": 0.1},
    "answer":   {"chatter": 3.0, "ask": 2.0, "agree": 1.5, "warn": 0.8,
                 "answer": 0.5, "refuse": 0.5, "greet": 0.2, "farewell": 0.5},
    "agree":    {"chatter": 3.0, "ask": 2.0, "warn": 1.0, "agree": 0.5,
                 "answer": 0.5, "refuse": 0.3, "greet": 0.2, "farewell": 0.5},
    "refuse":   {"chatter": 2.0, "ask": 2.0, "agree": 1.0, "warn": 1.0,
                 "answer": 1.0, "refuse": 0.5, "greet": 0.2, "farewell": 0.5},
    "warn":     {"agree": 2.0, "chatter": 2.0, "ask": 1.5, "warn": 1.0,
                 "refuse": 0.5, "answer": 0.5, "greet": 0.2, "farewell": 0.5},
    "chatter":  {"chatter": 4.0, "ask": 2.5, "agree": 1.0, "warn": 0.8,
                 "answer": 0.5, "refuse": 0.5, "greet": 0.3, "farewell": 0.5},
}

# Function words / generic openers that should never enter act_lex.
# Keeps the per-act lexicons focused on content vocabulary (the tokens
# that ACTUALLY characterise an act, like `thanks` for agree or
# `careful` for warn) instead of being dominated by `the / and / a`.
ACT_LEX_STOP = {
    "the", "a", "an", "and", "or", "but", "if", "of", "for", "to",
    "with", "at", "on", "in", "by", "from", "as", "than", "so", "is",
    "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "shall", "should", "can",
    "could", "may", "might", "must", "i", "you", "he", "she", "it",
    "we", "they", "me", "him", "her", "us", "them", "my", "your",
    "his", "hers", "its", "our", "their", "this", "that", "these",
    "those", "what", "who", "which", "where", "when", "why", "how",
    "well", "oh", "okay", "ok", "yeah", "right", "just", "very",
    "now", "then", "there", "here", "all", "some", "any", "out",
    "up", "down", "off", ".", "!", "?", ",",
}

BANNED = {
    "motherfucker", "motherfucking", "motherfuckers",
    "shit", "shitty", "shitting", "bullshit",
    "bitch", "bitches", "bitching",
    "bastard", "bastards",
    "damn", "damned", "damnit", "goddamn", "goddamned",
    "ass", "asshole", "assholes", "arse",
    "crap", "crappy",
    "dick", "dicks", "cock", "cocks",
    "pussy", "pussies",
    "hell", "piss", "pissed",
    "whore", "whores", "slut", "sluts",
    "bloody", "bollocks",
    "christ", "jesus",
    "cunt", "cunts", "twat", "twats",
    "prick", "pricks", "wanker", "wankers",
    "dickhead", "dickheads",
    "faggot", "faggots", "fag", "fags",
    "nigger", "niggers", "negro", "negroes",
    "chink", "chinks", "spic", "spics",
    "kike", "kikes", "gook", "gooks",
    "retard", "retards", "retarded",
}


@dataclass(frozen=True)
class SentenceRecord:
    raw_tokens: tuple[str, ...]
    tokens: tuple[str, ...]


@dataclass(frozen=True)
class TrainingRecord:
    raw_tokens: tuple[str, ...]
    tokens: tuple[str, ...]
    source: str
    weight: int = 1
    tone_hint: str | None = None
    act_hint: str | None = None
    name_hint: str | None = None


def ensure_corpus() -> Path:
    if LINES_PATH.exists():
        return LINES_PATH
    if not ZIP_PATH.exists():
        print(f"downloading {ZIP_URL} ...", file=sys.stderr)
        req = urllib.request.Request(
            ZIP_URL, headers={"User-Agent": "pers-demo/1.0"}
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            ZIP_PATH.write_bytes(r.read())
    print(f"extracting movie_lines.txt from {ZIP_PATH.name}", file=sys.stderr)
    with zipfile.ZipFile(ZIP_PATH) as zf:
        for info in zf.infolist():
            if info.filename.endswith("movie_lines.txt"):
                with zf.open(info) as src, open(LINES_PATH, "wb") as dst:
                    dst.write(src.read())
                break
        else:
            raise SystemExit("movie_lines.txt not found in archive")
    return LINES_PATH


def iter_sentence_records(path: Path):
    """Yield tokenised sentences with both raw-case and lowercase forms."""
    with open(path, "r", encoding="latin-1") as f:
        for raw in f:
            # Lines look like:
            #   LINE_ID +++$+++ USER_ID +++$+++ MOV_ID +++$+++ NAME +++$+++ TEXT
            parts = raw.split(" +++$+++ ")
            if len(parts) < 5:
                continue
            text = parts[4].strip()
            raw_tokens = TOKEN_RE.findall(text)
            if not raw_tokens:
                continue
            tokens = [t.lower() for t in raw_tokens]
            raw_sentence: list[str] = []
            sentence: list[str] = []
            for raw_t, t in zip(raw_tokens, tokens):
                raw_sentence.append(raw_t)
                sentence.append(t)
                if t in SENTENCE_END:
                    if len(sentence) >= 4:
                        yield SentenceRecord(tuple(raw_sentence), tuple(sentence))
                    raw_sentence = []
                    sentence = []
            if sentence and len(sentence) >= 4:
                yield SentenceRecord(tuple(raw_sentence), tuple(sentence))


def iter_sentences(path: Path):
    """Backward-compatible plain-token iterator."""
    for rec in iter_sentence_records(path):
        yield list(rec.tokens)


def iter_domain_records(path: Path):
    """Yield hand-curated in-world lines with tone/act/weight metadata.

    TSV format:
      tone<TAB>act<TAB>weight<TAB>text
    """
    if not path.exists():
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw or raw.startswith("#"):
                continue
            parts = raw.split("\t", 3)
            if len(parts) != 4:
                continue
            tone, act, weight_s, text = parts
            raw_tokens = TOKEN_RE.findall(text)
            if len(raw_tokens) < 4:
                continue
            tokens = tuple(t.lower() for t in raw_tokens)
            try:
                weight = max(1, int(weight_s))
            except ValueError:
                weight = 1
            yield TrainingRecord(
                raw_tokens=tuple(raw_tokens),
                tokens=tokens,
                source="domain",
                weight=weight,
                tone_hint=tone if tone in TONE_NAMES else None,
                act_hint=act or None,
            )


def iter_golden_seed_records(dir_path: Path):
    """Yield per-character curated lines from `corpus/golden_seeds/*.tsv`.

    Same TSV schema as `iter_domain_records` (`tone<TAB>act<TAB>weight<TAB>text`),
    but the per-token minimum is lowered to 2 — the curated bank deliberately
    contains short, clipped, in-character lines (especially for `zombie` and
    `ninja`) and we want them in the chain. The character name is taken from
    the filename stem and stored as `name_hint` so downstream filters and the
    audit can attribute lines by speaker if they care to.
    """
    if not dir_path.exists() or not dir_path.is_dir():
        return
    for tsv_path in sorted(dir_path.glob("*.tsv")):
        name_hint = tsv_path.stem
        with open(tsv_path, "r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw or raw.startswith("#"):
                    continue
                parts = raw.split("\t", 3)
                if len(parts) != 4:
                    continue
                tone, act, weight_s, text = parts
                raw_tokens = TOKEN_RE.findall(text)
                if len(raw_tokens) < 2:
                    continue
                tokens = tuple(t.lower() for t in raw_tokens)
                try:
                    weight = max(1, int(weight_s))
                except ValueError:
                    weight = 1
                yield TrainingRecord(
                    raw_tokens=tuple(raw_tokens),
                    tokens=tokens,
                    source="golden",
                    weight=weight,
                    tone_hint=tone if tone in TONE_NAMES else None,
                    act_hint=act or None,
                    name_hint=name_hint,
                )


def iter_training_records(path: Path, *, domain_path: Path,
                          golden_seeds_dir: Path):
    for rec in iter_sentence_records(path):
        yield TrainingRecord(
            raw_tokens=rec.raw_tokens,
            tokens=rec.tokens,
            source="cornell",
        )
    yield from iter_domain_records(domain_path)
    yield from iter_golden_seed_records(golden_seeds_dir)


def has_title(tokens):
    """Drop sentences that touch a name-style title.  We catch:
      - title + alpha-word that isn't a function word (`mr smith`)
      - title + sentence terminator/comma (`mr.` where the tokenizer
        already lost the proper noun trailing it).
    """
    safe_followups = {"and", "or", "of", "for", "the", "a", "an",
                      "i", "you", "we", "they", "it"}
    for i, t in enumerate(tokens):
        if t not in TITLES:
            continue
        if i + 1 >= len(tokens):
            return True
        nxt = tokens[i + 1]
        if nxt in {",", ".", "!", "?"}:
            return True
        if nxt.isalpha() and nxt not in safe_followups:
            return True
    return False


def is_vocative_addressee(tokens):
    """Catch `Goodnight, kringelein.` / `Bye, dad.` / `Good luck, austin.`:
    comma immediately before a single trailing alpha word that's then
    terminated.  These are almost always vocatives where the trailing
    word is the addressee's NAME, and movies overflow with them — they
    leak proper nouns into the chain.  We allow a short list of
    generic relations (dad/mom/friend/sir/...) so legit `Bye, friend.`
    style lines still survive.
    """
    if len(tokens) < 4:
        return False
    if tokens[-1] not in {".", "!", "?"}:
        return False
    name = tokens[-2]
    sep = tokens[-3]
    if sep != ",":
        return False
    if not name.isalpha():
        return False
    safe_addressees = {
        "friend", "buddy", "pal", "man", "guys", "everyone", "folks",
        "dad", "mom", "ma", "pa", "mommy", "daddy", "papa", "mama",
        "sir", "ma'am", "boss", "kid", "kiddo", "honey", "darling",
        "dear", "love", "sweetie", "babe", "baby", "boy", "girl",
        "son", "daughter", "brother", "sister", "people", "all",
        "captain", "doc", "doctor", "officer", "yourself",
    }
    return name not in safe_addressees


def is_intro_name_sentence(tokens):
    """Catch `hi, i'm erica.` / `hello, my name is bob.` style self-
    introductions that leak character names into the chain."""
    toks = [t for t in tokens if t not in {",", ".", "!", "?"}]
    if len(toks) < 3:
        return False
    safe_after_im = {
        "sorry", "fine", "okay", "ok", "ready", "afraid", "glad",
        "here", "back", "late", "alive", "sure",
    }
    safe_after_name_is = {
        "sorry", "fine", "okay", "ready", "important", "none",
        "nothing", "irrelevant",
    }
    if toks[0] in {"hi", "hello", "hey"}:
        if len(toks) >= 3 and toks[1] in {"i'm", "im"}:
            return toks[2].isalpha() and toks[2] not in safe_after_im
        if len(toks) >= 5 and toks[1:4] == ["my", "name", "is"]:
            return toks[4].isalpha() and toks[4] not in safe_after_name_is
    return False


def is_capitalized_name_candidate(raw_word: str, lower_word: str) -> bool:
    if lower_word in SAFE_NAMEY or lower_word in TITLES:
        return False
    if len(lower_word) < 3 or not lower_word.isalpha():
        return False
    return bool(CAPITALIZED_RE.fullmatch(raw_word))


def alpha_tokens(tokens):
    return [t for t in tokens if t.isalpha()]


def normalized_sentence_key(tokens):
    return " ".join(alpha_tokens(tokens))


def has_banned_token(tokens):
    return any(t in BANNED for t in tokens if t.isalpha())


def has_stutter_loop(tokens):
    alpha = alpha_tokens(tokens)
    if len(alpha) < 4:
        return False
    run = 1
    for i in range(1, len(alpha)):
        if alpha[i] == alpha[i - 1]:
            run += 1
            if run >= 3:
                return True
        else:
            run = 1
    if len(alpha) >= 6:
        for i in range(0, len(alpha) - 5):
            if alpha[i:i + 2] == alpha[i + 2:i + 4] == alpha[i + 4:i + 6]:
                return True
    return False


def is_low_information_shape(tokens):
    alpha = alpha_tokens(tokens)
    if len(alpha) < 4:
        return False
    uniq = len(set(alpha))
    if len(alpha) >= 6 and uniq <= 2:
        return True
    if len(alpha) >= 8 and uniq <= 3:
        return True
    return False


def collect_filters(path: Path, *, domain_path: Path,
                    golden_seeds_dir: Path, rare_drop: int):
    """Mine rare words and name-like leakage candidates from the corpus."""
    print("first pass: token frequencies + name-like leakage filter...",
          file=sys.stderr)
    freq: Counter[str] = Counter()
    cap_mid: Counter[str] = Counter()
    n_pass1 = 0
    source_counts: Counter[str] = Counter()
    for rec in iter_training_records(path, domain_path=domain_path,
                                      golden_seeds_dir=golden_seeds_dir):
        tokens = list(rec.tokens)
        if (has_title(tokens) or is_vocative_addressee(tokens)
                or is_intro_name_sentence(tokens)
                or has_banned_token(tokens)
                or has_stutter_loop(tokens)
                or is_low_information_shape(tokens)):
            continue
        alpha_pos = 0
        for raw_t, t in zip(rec.raw_tokens, rec.tokens):
            if not t.isalpha():
                continue
            freq[t] += rec.weight
            if alpha_pos > 0 and is_capitalized_name_candidate(raw_t, t):
                cap_mid[t] += rec.weight
            alpha_pos += 1
        n_pass1 += 1
        source_counts[rec.source] += 1
    rare = {w for w, c in freq.items() if c < rare_drop}
    namey = {
        w for w, c in freq.items()
        if cap_mid[w] >= 2
        and cap_mid[w] / c >= 0.55
        and w not in rare
    }
    print(f"  {n_pass1:,} sentences, {len(freq):,} types, "
          f"{len(rare):,} rare (<{rare_drop}x), "
          f"{len(namey):,} name-like", file=sys.stderr)
    return freq, rare, namey, source_counts


def has_too_many_rare_tokens(tokens, rare, *, rare_line_max: int):
    alpha = [t for t in tokens if t.isalpha()]
    if not alpha:
        return False
    rare_alpha = [t for t in alpha if t in rare]
    if not rare_alpha:
        return False
    # One weird low-frequency opener is much more harmful than one odd
    # content word in the middle of an otherwise clean sentence.
    if any(t in rare for t in alpha[:2]):
        return True
    if len(rare_alpha) > rare_line_max:
        return True
    return (len(rare_alpha) / len(alpha)) > 0.34


def should_drop_sentence(tokens, *, rare, namey, rare_line_max: int):
    if (has_title(tokens) or is_vocative_addressee(tokens)
            or is_intro_name_sentence(tokens)):
        return True
    if has_banned_token(tokens):
        return True
    if has_stutter_loop(tokens):
        return True
    if is_low_information_shape(tokens):
        return True
    if any(t in namey for t in tokens if t.isalpha()):
        return True
    return has_too_many_rare_tokens(tokens, rare, rare_line_max=rare_line_max)


def classify_tone(tokens):
    """Pick the dominant tone lexicon hit; default `calm`.

    Looking at the first 8 tokens (opener + a couple of follow-ups)
    catches the flavour of the line without dragging in the drift of
    long monologues.
    """
    head = set(tokens[:8])
    tense = len(head & TONE_LEX["tense"])
    shaken = len(head & TONE_LEX["shaken"])
    if tense == 0 and shaken == 0:
        return "calm"
    if tense >= shaken:
        return "tense"
    return "shaken"


def dedup_key(tokens):
    alpha = alpha_tokens(tokens)
    if not alpha:
        return ""
    return " ".join(alpha)


def load_start_banlist(path: Path | None) -> set[tuple[str, ...]]:
    """Read the offline-scored starts-banlist (one start per line,
    space-separated tokens, lowercase, '#'-comments allowed).
    Returns a set of token tuples for fast lookup at training time."""
    if not path:
        return set()
    if not path.exists():
        print(f"start banlist {path} not found, skipping", file=sys.stderr)
        return set()
    out: set[tuple[str, ...]] = set()
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            out.add(tuple(line.split()))
    print(f"loaded start banlist: {len(out):,} entries from {path}",
          file=sys.stderr)
    return out


def build_model(path: Path, *, order: int, min_count: int,
                canned_weight: int, max_nexts: int, max_starts: int,
                rare_drop: int, rare_line_max: int,
                domain_path: Path = DOMAIN_LINES_PATH,
                golden_seeds_dir: Path = GOLDEN_SEEDS_DIR,
                hybrid_backoff: bool = False,
                selective_trigram_budget: int = 0,
                start_banlist: set[tuple[str, ...]] | None = None,
                start_len: int | None = None) -> dict:
    """Build the Markov model in two passes.

    Pass 1 counts tokens and mines mid-sentence capitalisation patterns
    so we can drop likely names without having to nuke every sentence
    that contains one odd word.
    Pass 2 builds the actual chain, tone-tags each start, then prunes
    transitions and starts down to the configured caps.
    """
    freq, rare, namey, source_counts = collect_filters(
        path, domain_path=domain_path,
        golden_seeds_dir=golden_seeds_dir, rare_drop=rare_drop
    )

    # Canned greeting/farewell seed lines so the chain has clean
    # openers/closers regardless of the corpus.  Weight kept LOW
    # (×8): high weights bake the same handful of greetings into
    # every batch ("Goodbye and safe travels to you." over and over).
    canned = [
        "hello there friend how are you doing today .",
        "hi nice to see you again .",
        "good morning to you my friend .",
        "i hope you are doing well today .",
        "take care and see you later .",
        "see you around my friend .",
        "goodbye and safe travels to you .",
        "farewell until we meet again .",
    ]

    # Allow --start-len < order (eg. order=3, start_len=2): for higher-
    # order models this is critical for tone signal.  Length-3 starts
    # shrink the per-tone start pool to a sparse tail, which directly
    # tanks the audit's tense / shaken metric (-7 to -10 pp in the
    # selective-trigram experiment).  Length-2 starts on a length-3
    # body keep the rich length-2 tone pool and let the bigram backoff
    # carry the first generation step until the chain has `order`
    # tokens.  v8 packing format is used in this case.
    if start_len is None:
        start_len = order
    if not (2 <= start_len <= order):
        raise ValueError(
            f"start_len must be between 2 and order (got {start_len}, order={order})"
        )

    starts: Counter[tuple] = Counter()
    starts_tone: dict[tuple, Counter[str]] = defaultdict(Counter)
    starts_act: dict[tuple, Counter[str]] = defaultdict(Counter)
    act_pair_counts: Counter[tuple[str, str]] = Counter()  # (prev_act, this_act)
    act_lex_counts: dict[str, Counter[str]] = {a: Counter() for a in ACT_NAMES}
    trans: defaultdict[tuple, Counter[str]] = defaultdict(Counter)
    # Selective-trigram mode always needs the bigram backoff (it's the
    # whole point: ship a small-but-targeted trigram table and let the
    # bigram backoff cover everything else, with runtime interpolation
    # blending the two when both fire).
    # Same goes for length-2 starts on a higher-order body — the
    # runtime has to fall through to bigram for the first step.
    needs_backoff = (
        (hybrid_backoff or selective_trigram_budget > 0 or start_len < order)
        and order > 2
    )
    backoff_trans: defaultdict[tuple, Counter[str]] | None = (
        defaultdict(Counter) if needs_backoff else None
    )
    seen_short_keys: set[str] = set()

    def feed(tokens, tone, weight, act=None):
        if len(tokens) < order + 1:
            return
        if act is None:
            act = classify_act(tokens)
        key0 = tuple(tokens[:start_len])
        starts[key0] += weight
        starts_tone[key0][tone] += weight
        starts_act[key0][act] += weight
        # Accumulate act-lex: count non-stop content tokens for this act
        # (skip punctuation and stop words).
        for tok in tokens:
            if tok not in ACT_LEX_STOP and tok.isalpha():
                act_lex_counts[act][tok] += weight
        for i in range(len(tokens) - order):
            key = tuple(tokens[i:i + order])
            trans[key][tokens[i + order]] += weight
        if backoff_trans is not None:
            for i in range(len(tokens) - 2):
                key = tuple(tokens[i:i + 2])
                backoff_trans[key][tokens[i + 2]] += weight

    for line in canned:
        feed(line.split(), "calm", canned_weight, act="greet")

    print("second pass: building model...", file=sys.stderr)
    n = 0
    n_kept = 0
    for rec in iter_training_records(path, domain_path=domain_path,
                                      golden_seeds_dir=golden_seeds_dir):
        sentence = list(rec.tokens)
        n += 1
        if should_drop_sentence(
                sentence, rare=rare, namey=namey,
                rare_line_max=rare_line_max):
            continue
        dkey = dedup_key(sentence)
        if dkey and len(dkey.split()) <= 7 and dkey in seen_short_keys:
            continue
        if dkey and len(dkey.split()) <= 7:
            seen_short_keys.add(dkey)
        tone  = rec.tone_hint or classify_tone(sentence)
        # Normalise legacy act names from domain TSV
        # (greeting→greet, warning→warn, question→ask,
        #  promise→agree, calm→chatter)
        raw_act = rec.act_hint or ""
        _ACT_ALIAS = {
            "greeting": "greet", "warning": "warn",
            "question": "ask",   "promise": "agree",
            "calm":     "chatter",
        }
        act = _ACT_ALIAS.get(raw_act, raw_act)
        if act not in ACT_NAMES:
            act = classify_act(sentence)
        feed(sentence, tone, rec.weight, act=act)
        n_kept += 1
        if n % 100_000 == 0:
            print(f"  scanned {n:,} sentences, kept {n_kept:,}", file=sys.stderr)
    print(f"  total scanned {n:,}, kept {n_kept:,}", file=sys.stderr)

    # Prune rare transitions and cap continuations per state.
    pruned_trans: dict[str, list[list]] = {}
    for key, nexts in trans.items():
        kept = [(w, c) for w, c in nexts.items() if c >= min_count]
        if not kept:
            continue
        kept.sort(key=lambda wc: -wc[1])
        kept = kept[:max_nexts]
        pruned_trans[" ".join(key)] = [[w, c] for w, c in kept]

    # Selective-trigram pruning: keep only the highest-value higher-order
    # states, drop the rest.  Score combines mass (total count) with
    # disambiguation value (log fanout, since a state with one possible
    # next word adds nothing the bigram backoff can't already do).
    # Anything we drop is silently picked up by the (untouched) bigram
    # backoff at runtime, optionally blended with surviving trigram
    # states via interpolation.
    selective_kept = 0
    if order > 2 and selective_trigram_budget > 0 and pruned_trans:
        scored: list[tuple[float, str]] = []
        for k, nexts in pruned_trans.items():
            total = sum(c for _, c in nexts)
            fanout = len(nexts)
            if fanout < 2:
                continue
            score = total * (1.0 + math.log(fanout))
            scored.append((score, k))
        scored.sort(reverse=True)
        keep_keys = set(k for _, k in scored[:selective_trigram_budget])
        pruned_trans = {k: v for k, v in pruned_trans.items() if k in keep_keys}
        selective_kept = len(pruned_trans)

    pruned_backoff: dict[str, list[list]] | None = None
    if backoff_trans is not None:
        pruned_backoff = {}
        for key, nexts in backoff_trans.items():
            kept = [(w, c) for w, c in nexts.items() if c >= min_count]
            if not kept:
                continue
            kept.sort(key=lambda wc: -wc[1])
            kept = kept[:max_nexts]
            pruned_backoff[" ".join(key)] = [[w, c] for w, c in kept]

    # Keep starts that survived, in popularity order, capped at
    # `max_starts`.  We also save per-start weights so the runtime
    # can do flattened (sub-linear) sampling — biasing AWAY from the
    # heaviest openers that otherwise dominate every batch.
    chosen_starts = starts.most_common(max_starts)
    start_list: list[list[str]] = []
    start_weights: list[int] = []
    starts_by_tone: dict[str, list[list[str]]] = {t: [] for t in TONE_NAMES}
    weights_by_tone: dict[str, list[int]] = {t: [] for t in TONE_NAMES}
    starts_by_act: dict[str, list[list[str]]] = {a: [] for a in ACT_NAMES}
    weights_by_act: dict[str, list[int]] = {a: [] for a in ACT_NAMES}
    # In selective-trigram mode the great majority of trigram states get
    # pruned away, so we accept starts whose first two tokens are
    # represented in EITHER the trigram trans OR the bigram backoff —
    # the runtime knows how to fall through.
    backoff_keys = set(pruned_backoff.keys()) if pruned_backoff else set()
    banlist = start_banlist or set()
    banned_n = 0
    for key, c in chosen_starts:
        if key in banlist:
            banned_n += 1
            continue
        joined = " ".join(key)
        # Three viability paths:
        #   1. start key directly hits the order-N trans table.
        #   2. order > 2 + backoff: the LAST 2 tokens hit the bigram
        #      backoff (selective-trigram + hybrid-trigram cases).
        #   3. start_len < order + backoff: the start tuple itself hits
        #      the bigram backoff (v8 short-start case — the runtime
        #      uses backoff for the first step).
        if joined not in pruned_trans:
            tail_bigram = " ".join(key[-2:]) if len(key) >= 2 else None
            if (order > 2 and pruned_backoff
                    and tail_bigram in backoff_keys):
                pass
            elif (start_len < order and pruned_backoff
                  and joined in backoff_keys):
                pass
            else:
                continue
        start_list.append(list(key))
        start_weights.append(int(c))
        tone_counts = starts_tone[key]
        dominant_tone = (max(tone_counts.items(), key=lambda kv: kv[1])[0]
                         if tone_counts else "calm")
        starts_by_tone[dominant_tone].append(list(key))
        weights_by_tone[dominant_tone].append(int(c))
        act_counts = starts_act[key]
        dominant_act = (max(act_counts.items(), key=lambda kv: kv[1])[0]
                        if act_counts else "chatter")
        starts_by_act[dominant_act].append(list(key))
        weights_by_act[dominant_act].append(int(c))

    # Build act_lex: top-30 content words per act, excluding common stop words
    # and words that appear in many acts (cross-act noise).  We use a simple
    # tf-like score: raw count within the act, normalised by the geometric
    # mean count across all acts so universal words (like "just") are pushed
    # down even if they're not in ACT_LEX_STOP.
    ACT_LEX_SIZE = 30
    all_act_totals = {a: sum(act_lex_counts[a].values()) or 1
                      for a in ACT_NAMES}
    act_lex: dict[str, list[str]] = {}
    for act in ACT_NAMES:
        top = act_lex_counts[act].most_common(ACT_LEX_SIZE * 5)
        scored = []
        for w, c in top:
            if w in ACT_LEX_STOP or not w.isalpha() or len(w) < 3:
                continue
            tf = c / all_act_totals[act]
            scored.append((tf, w))
        scored.sort(reverse=True)
        act_lex[act] = [w for _, w in scored[:ACT_LEX_SIZE]]

    # act_trans: for each act, store a {next_act: normalised_weight} dict.
    # We blend the corpus-observed bigram counts with the hand-crafted prior
    # (ACT_TRANS_PRIOR) using add-k smoothing (k = total_observed * 0.2).
    # If the corpus contributed nothing for a pair we fall back to the prior.
    act_trans: dict[str, dict[str, float]] = {}
    for prev_act in ACT_NAMES:
        row: dict[str, float] = {}
        for next_act in ACT_NAMES:
            prior_w = ACT_TRANS_PRIOR.get(prev_act, {}).get(next_act, 0.1)
            row[next_act] = prior_w
        total = sum(row.values())
        act_trans[prev_act] = {k: round(v / total, 4) for k, v in row.items()}

    out = {
        "order": order,
        "start_len": start_len,
        "starts": start_list,
        "start_weights": start_weights,
        "starts_by_tone": starts_by_tone,
        "start_weights_by_tone": weights_by_tone,
        "starts_by_act": starts_by_act,
        "start_weights_by_act": weights_by_act,
        "act_trans": act_trans,
        "act_lex": act_lex,
        "trans": pruned_trans,
        "n_sentences": n_kept,
        "blocked_namey_tokens": sorted(namey, key=lambda w: (-freq[w], w))[:256],
        "trainer_stats": {
            "rare_drop": rare_drop,
            "rare_line_max": rare_line_max,
            "rare_types": len(rare),
            "namey_types": len(namey),
            "source_counts": dict(source_counts),
            "domain_lines": int(source_counts.get("domain", 0)),
            "golden_lines": int(source_counts.get("golden", 0)),
            "hybrid_backoff": bool(pruned_backoff),
            "selective_trigram_budget": int(selective_trigram_budget),
            "selective_trigram_kept": int(selective_kept),
            "start_banlist_size": len(banlist),
            "starts_banned": int(banned_n),
            "act_starts": {a: len(starts_by_act[a]) for a in ACT_NAMES},
        },
    }
    if pruned_backoff:
        out["backoff_trans"] = pruned_backoff
    return out

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    # Defaults below = the current production recipe.  Override only if
    # you're experimenting; the audit harness in audit_dialog.py
    # drives those sweeps for you.
    ap.add_argument("--order", type=int, default=2,
                    help="n-gram order (2 = bigram, 3 = trigram). 2 is the "
                         "current production default; v6 packing can carry "
                         "trigram experiments, but they didn't beat the tuned "
                         "bigram branch cleanly enough to ship.")
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    ap.add_argument("--min-count", type=int, default=2,
                    help="drop transitions seen fewer than this many times")
    ap.add_argument("--max-nexts", type=int, default=64,
                    help="cap continuations per state — bigger = more variety, "
                         "more JSON")
    ap.add_argument("--max-starts", type=int, default=8000,
                    help="cap distinct sentence openers")
    ap.add_argument("--canned-weight", type=int, default=5,
                    help="repetition weight for the hand-written canned "
                         "greeting/farewell lines")
    ap.add_argument("--rare-drop", type=int, default=5,
                    help="any token seen fewer than this many times across the "
                         "corpus (after the title/vocative filter) is treated as "
                         "rare")
    ap.add_argument("--rare-line-max", type=int, default=1,
                    help="drop a sentence only when it contains more than this "
                         "many rare alpha tokens (or a rare opener); softer than "
                         "the old any-rare-word kill switch")
    ap.add_argument("--domain-path", type=Path, default=DOMAIN_LINES_PATH,
                    help="optional TSV of in-world dialogue lines layered on top "
                         "of Cornell: tone<TAB>act<TAB>weight<TAB>text")
    ap.add_argument("--golden-seeds-dir", type=Path, default=GOLDEN_SEEDS_DIR,
                    help="optional directory of per-character curated TSVs "
                         "(corpus/golden_seeds/<name>.tsv) layered on top of "
                         "the domain TSV. Same row schema, but min token count "
                         "is 2 (vs domain's 4) so terse character voices "
                         "(zombie / ninja) survive the filter.")
    ap.add_argument("--hybrid-backoff", action="store_true",
                    help="for order>2 models, also export an exact bigram "
                         "backoff table for hybrid higher-order runtime tests")
    ap.add_argument("--selective-trigram-budget", type=int, default=0,
                    help="for order>2 models, keep only the top-N "
                         "highest-value trigram states (scored by "
                         "count*(1+log(fanout))) and rely on the bigram "
                         "backoff for everything else.  Implies "
                         "--hybrid-backoff and produces a much smaller "
                         "payload than full trigram while still adding "
                         "context for the states that benefit most.")
    ap.add_argument("--start-banlist", type=Path, default=None,
                    help="path to a file produced by tools/score_starts.py "
                         "(one start per line, space-separated tokens).  "
                         "Listed openers are dropped from the trained model.")
    ap.add_argument("--start-len", type=int, default=None,
                    help="length of each start tuple. Defaults to --order. "
                         "Set to 2 with --order 3 (v8 layout) to keep the "
                         "rich length-2 tone start pool while running a "
                         "trigram body — the runtime uses bigram backoff "
                         "for the first generation step.")
    args = ap.parse_args()

    banlist = load_start_banlist(args.start_banlist)
    path = ensure_corpus()
    model = build_model(
        path,
        order=args.order,
        min_count=args.min_count,
        canned_weight=args.canned_weight,
        max_nexts=args.max_nexts,
        max_starts=args.max_starts,
        rare_drop=args.rare_drop,
        rare_line_max=args.rare_line_max,
        domain_path=args.domain_path,
        golden_seeds_dir=args.golden_seeds_dir,
        hybrid_backoff=(args.hybrid_backoff
                        or args.selective_trigram_budget > 0
                        or (args.start_len is not None
                            and args.start_len < args.order)),
        selective_trigram_budget=args.selective_trigram_budget,
        start_banlist=banlist,
        start_len=args.start_len,
    )
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(model, f, separators=(",", ":"))
    size_kb = args.out.stat().st_size / 1024
    sbt = {k: len(v) for k, v in model["starts_by_tone"].items()}
    print(
        f"wrote {args.out.name}: {size_kb:.0f} KB, "
        f"order={args.order}, {len(model['trans']):,} states, "
        f"{len(model['starts']):,} starts (by tone: {sbt})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
