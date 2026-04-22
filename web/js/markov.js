/*
 * Word-level Markov text generator.
 *
 * Loads the bigram model produced by train_dialog.py and exposes
 * `Markov.generate(options)` which returns a single punctuated
 * sentence.  Generation walks the chain until a sentence terminator
 * is reached, biases the picker toward terminators near `maxWords`
 * so we don't get force-truncated mid-clause, and rejects sentences
 * that end on a connective ("...the.") or on a subject pronoun in a
 * long line ("...all in this world you.").
 *
 * The model bytes are produced by build.py:pack_model and shipped
 * inside the combined `bolklets_code.png` payload (see payload.js);
 * call `Markov.init(bytes)` with the bytes of the "model" section to
 * unpack the model into memory.
 *
 * Tone-tagged starts: the trainer classifies each opener as calm /
 * tense / shaken using a small lexicon.  When the dialog layer asks
 * for an opener with a `tone:` of its own, we sample from the
 * matching bucket with probability `toneChance` so a combat scene
 * doesn't open with "Long time no see, friend!" and a calm chat
 * doesn't lead with "Watch behind you!".
 */
const Markov = (() => {
  let model = null;
  let actMeta = null;   // loaded separately via initAct()
  let ready = false;

  const ACT_NAMES = [
    "greet", "farewell", "ask", "answer",
    "agree", "refuse", "warn", "chatter",
  ];

  // Words we never want appearing in the little kid-friendly bubbles
  // above the characters.  Generating past them is trivial at word-
  // level, so we simply retry generation whenever one slips through.
  // The crude-anatomy + slur cluster at the bottom was added after a
  // post-v4 audit caught "You fuckin' cunt." and "Let's go niggers!"
  // slipping through; none of these ever belong on the lawn,
  // regardless of corpus.
  const BANNED = new Set([
    "fuck", "fucking", "fucked", "fucker", "fuckin",
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
  ]);

  // Banlist matching is case-insensitive and also strips edge
  // apostrophes — "fuckin'" with a trailing apostrophe slipped past
  // a literal lookup in the v4 audit even though "fuckin" was on
  // the list.  Centralised so generate() and isClean() stay in sync.
  function bannedKey(token) {
    let t = token.toLowerCase();
    if (t.length && t.charCodeAt(0) === 39 /* ' */) t = t.slice(1);
    if (t.length && t.charCodeAt(t.length - 1) === 39) t = t.slice(0, -1);
    return t;
  }

  const SENTENCE_END = new Set([".", "!", "?"]);
  const SOFT_BREAK = new Set([",", ";"]);

  // Tail words that should never sit at the end of a sentence — they
  // signal the chain ran into max_words mid-clause and we'd be force-
  // appending a `.`.  Better to retry than emit "...for the." into a
  // bubble.
  const DEAD_END_TAILS = new Set([
    "a", "an", "the", "and", "or", "but", "if", "of", "for", "to",
    "with", "at", "on", "in", "by", "from", "as", "than", "so", "is",
    "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "my", "your", "his", "her", "its", "our", "their", "this", "that",
    "these", "those",
    // Modal verbs + informal contractions that almost never close a
    // real sentence in dialogue: "Anyway, I could.", "What about
    // the?", "He just got some kinda.".  Added after the post-v4
    // hardtails experiment.
    "could", "would", "should", "might", "must", "shall", "will",
    "ought",
    "kinda", "sorta", "gonna", "wanna",
    "ain't",
  ]);

  // Subject pronouns + contractions: legitimate as endings in very
  // short utterances ("I love you.", "It's me."), but a long line
  // ending on one almost always means we cut a clause off mid-flow:
  // "Look, this is all in this world you.".  Cap the leniency at
  // SUBJECT_TAIL_MAX_LEN words.
  const SUBJECT_TAILS = new Set([
    "i", "you", "we", "they", "he", "she", "it",
    "i'm", "you're", "we're", "they're", "he's", "she's", "it's",
    "i've", "you've", "we've", "they've",
    "i'll", "you'll", "we'll", "they'll", "he'll", "she'll", "it'll",
    "i'd", "you'd", "we'd", "they'd", "he'd", "she'd",
  ]);
  const SUBJECT_TAIL_MAX_LEN = 4;

  // First-word lookups for smart end-punctuation.  When the chain
  // closes a sentence with `.` we swap it for `?` if the opener is
  // interrogative (`Are you sure?`, `Haven't I told you?`) — and for
  // `!` when the opener is a short imperative (`Hold the line!`).
  // Mostly cosmetic, but a question that ends with `.` reads as a
  // typo every single time.
  const QUESTION_STARTERS = new Set([
    "who", "what", "when", "where", "why", "how", "which",
    "are", "is", "am", "was", "were",
    "do", "does", "did",
    "have", "has", "had",
    "can", "could", "will", "would", "shall", "should", "may", "might",
    "what's", "where's", "who's", "how's", "why's", "when's",
    "haven't", "hasn't", "hadn't", "didn't", "doesn't", "don't",
    "isn't", "aren't", "wasn't", "weren't",
    "wouldn't", "couldn't", "shouldn't", "can't",
    "won't", "shan't", "mightn't",
  ]);
  const IMPERATIVE_STARTERS = new Set([
    "stop", "listen", "look", "come", "get", "go", "run", "wait",
    "stay", "hold", "watch", "let's", "tell", "give", "take", "drop",
    "leave", "stand", "back", "down", "hush", "easy", "quick",
    "hurry", "shoot", "fire", "duck", "behind", "above", "ready",
    "draw", "burn", "cover", "move", "follow", "guard",
  ]);
  const SHORT_IMPERATIVE_MAX_LEN = 5;

  // Fragment-style stranded openers — bigrams that almost never lead
  // to a self-contained sentence.  ("Long as we're here on the line.",
  // "Which is what I meant.", …)  Rejected at start-pick time so the
  // generator just rolls the dice again instead of having to clean
  // up the mess at the tail end.
  const FRAGMENT_STARTS = new Set([
    "long as", "as long",
    "which is", "which means", "which was",
    "that's why", "that's because", "that's what", "that's how",
    "so that", "so when",
    "even if", "even when", "even though",
    "because i", "because we", "because the", "because you", "because they",
    "if only", "if not",
    "in case", "in fact",
    "the fact",
  ]);

  // Tone bucket index — must match TONE_NAMES in build.py.  The
  // packer writes one byte per start with the bucket id; we decode
  // back into named lists at load time.
  const TONE_NAMES = ["calm", "tense", "shaken"];

  // Tone lexicons used for mid-chain reweighting.  Mirrors TONE_LEX
  // in tools/train_dialog.py.  When the dialog layer asks Markov to
  // generate a tense / shaken line, we boost the weight of any
  // continuation that lands in the matching lexicon — same idea as
  // the existing end-bias on terminators, but for tone signal.
  // Without this, tone is only enforced at start selection: the
  // chain quickly drifts back toward generic continuations and the
  // bubble loses its tense / shaken vibe by the third or fourth
  // word.
  const TONE_LEX = {
    tense: new Set([
      "watch", "behind", "careful", "stay", "keep", "quiet", "down",
      "above", "around", "moving", "wait", "easy", "ready", "weapons",
      "eyes", "cover", "run", "stop", "hide", "danger", "shh", "shhh",
      "move", "duck", "freeze", "back", "drop", "hurry", "quick",
      "fast", "now", "go", "listen", "look", "hold", "stand",
      "ahead",
      "weapon", "gun", "knife", "blade", "sword", "shoot", "shot",
      "kill", "killed", "killing", "dead", "die", "dying", "monster",
      "creature", "blood", "fight", "fighting", "attack",
      "attacking", "enemy", "enemies", "trouble", "dangerous",
      "scared", "afraid", "they're", "coming", "incoming",
    ]),
    shaken: new Set([
      "almost", "close", "alive", "phew", "lucky", "thank", "safe",
      "rest", "breathe", "breathing", "still", "broken", "hurt",
      "wounded", "barely", "scared", "shaking", "whew", "trembling",
      "okay", "alright", "fine", "made", "survived", "survive",
      "escaped", "escape", "lost", "tired", "weak", "exhausted",
      "blessed", "spared", "lived", "saved", "miraculously",
      "incredible", "unbelievable", "thought", "feared",
      "sorry", "well", "god", "goodness", "heavens",
      "moment", "second", "minute", "shock", "scare", "frightened",
      "trembled", "hands",
    ]),
  };

  // Interpolation lambda for hybrid higher-order models: when the
  // chain is at a state that has BOTH a trigram continuation table and
  // a matching bigram backoff, we blend the two distributions:
  //
  //   p(next | trigram, bigram) =
  //       lambda * p_trigram(next) + (1 - lambda) * p_bigram(next)
  //
  // This is just linear interpolation smoothing.  Pure trigram is
  // sharp but sometimes commits to a low-mass continuation that the
  // bigram backoff would have rejected; pure bigram is the existing
  // production fallback.  A 0.7/0.3 blend keeps the trigram's local
  // context advantage while letting the bigram pull the chain back
  // toward the corpus average when the trigram state is thin.
  const INTERP_LAMBDA = 0.7;
  // Precision used to fold the blended floating-point distribution
  // back into the [word, integer-count] pairs that weightedPick()
  // expects.  Big enough that a 0.0001-mass continuation still gets
  // a nonzero count, small enough that we don't blow up the array
  // sort cost.
  const INTERP_SCALE = 100000;

  function interpolateDist(triList, biList, lambda) {
    let triTotal = 0;
    for (let i = 0; i < triList.length; i++) triTotal += triList[i][1];
    let biTotal = 0;
    for (let i = 0; i < biList.length; i++) biTotal += biList[i][1];
    if (triTotal <= 0 || biTotal <= 0) return triList;
    const acc = Object.create(null);
    const wTri = lambda / triTotal;
    const wBi = (1 - lambda) / biTotal;
    for (let i = 0; i < triList.length; i++) {
      const w = triList[i][0];
      acc[w] = (acc[w] || 0) + wTri * triList[i][1];
    }
    for (let i = 0; i < biList.length; i++) {
      const w = biList[i][0];
      acc[w] = (acc[w] || 0) + wBi * biList[i][1];
    }
    const out = [];
    for (const w in acc) {
      const c = Math.round(acc[w] * INTERP_SCALE);
      if (c > 0) out.push([w, c]);
    }
    return out.length ? out : triList;
  }

  function buildBigramBackoff(trans, order) {
    if (!trans || order <= 2) return null;
    const buckets = Object.create(null);
    for (const key in trans) {
      if (!Object.prototype.hasOwnProperty.call(trans, key)) continue;
      const parts = key.split(" ");
      if (parts.length !== order) continue;
      const backoffKey = parts[parts.length - 2] + " " + parts[parts.length - 1];
      let bucket = buckets[backoffKey];
      if (!bucket) {
        bucket = Object.create(null);
        buckets[backoffKey] = bucket;
      }
      const nexts = trans[key];
      for (let i = 0; i < nexts.length; i++) {
        const word = nexts[i][0];
        bucket[word] = (bucket[word] || 0) + nexts[i][1];
      }
    }
    const out = Object.create(null);
    for (const key in buckets) {
      if (!Object.prototype.hasOwnProperty.call(buckets, key)) continue;
      const list = [];
      const bucket = buckets[key];
      for (const word in bucket) {
        if (!Object.prototype.hasOwnProperty.call(bucket, word)) continue;
        list.push([word, bucket[word]]);
      }
      list.sort((a, b) => b[1] - a[1]);
      out[key] = list;
    }
    return out;
  }

  // Parse the binary Markov model blob produced by build.py:pack_model.
  // Layout (version 5, all multi-byte ints are LEB128 varints):
  //   u8      version (== 5)
  //   varint  vocab_size
  //   vocab_size words, each a run of ASCII bytes; the LAST byte of
  //     a word has its high bit set (since the training corpus only
  //     contains [A-Za-z'.,!?] we can use bit 7 as a free word
  //     terminator and skip per-word length prefixes).
  //   varint  n_starts
  //   varint  n_start_groups
  //   varint  n_groups
  //   11 × varint   byte length of each column below, in stream order.
  //   col_sg_dw1   start-group Δw1 stream
  //   col_sg_n     entries-per-start-group stream
  //   col_sg_dw2   Δw2-within-start-group stream
  //   col_g_dw1    trans-group Δw1 stream
  //   col_g_n      entries-per-trans-group stream
  //   col_e_dw2    Δw2-within-trans-entry stream
  //   col_e_fan    fanout stream
  //   col_n_dnext  Δnext-word stream
  //   col_n_count  per-edge count stream (counts are pow2-quantised
  //                at pack time so this column collapses to a small
  //                set of distinct values)
  //   col_starts_w   per-start weight stream (one varint per start in
  //                  iteration order; pow2-quantised)
  //   col_starts_tone per-start tone tag (one byte per start in
  //                  iteration order; 0=calm, 1=tense, 2=shaken)
  function parseModelBinary(bytes) {
    let p = 0;
    function vi() {
      let result = 0, shift = 0, b;
      for (;;) {
        b = bytes[p++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return result >>> 0;
        shift += 7;
      }
    }
    const version = bytes[p++];
    const td = new TextDecoder("utf-8");
    if (version !== 5 && version !== 6 && version !== 7) {
      throw new Error(`unknown model version ${version}`);
    }
    const order = (version === 6 || version === 7) ? vi() : 2;
    const vocabSize = vi();
    const vocab = new Array(vocabSize);
    for (let i = 0; i < vocabSize; i++) {
      const start = p;
      while ((bytes[p] & 0x80) === 0) p++;
      const wordBytes = bytes.slice(start, p + 1);
      wordBytes[wordBytes.length - 1] &= 0x7f;
      vocab[i] = td.decode(wordBytes);
      p++;
    }
    if (version === 6 || version === 7) {
      const nStarts = vi();
      const nStates = vi();
      const nBackoff = version === 7 ? vi() : 0;
      const colCount = version === 7 ? 11 : 7;
      const colLens = new Array(colCount);
      for (let i = 0; i < colCount; i++) colLens[i] = vi();
      function makeReader(start) {
        let q = start;
        return function () {
          let result = 0, shift = 0, b;
          for (;;) {
            b = bytes[q++];
            result |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0) return result >>> 0;
            shift += 7;
          }
        };
      }
      let off = p;
      const readers = new Array(colCount);
      const colOffsets = new Array(colCount);
      for (let i = 0; i < colCount; i++) {
        colOffsets[i] = off;
        readers[i] = makeReader(off);
        off += colLens[i];
      }
      const readStartWord = readers[0];
      const readStartW = readers[1];
      const readStateWord = readers[3];
      const readStateFan = readers[4];
      const readNextWord = readers[5];
      const readNextCount = readers[6];
      const startsToneOffset = colOffsets[2];
      const starts = new Array(nStarts);
      const startWeights = new Array(nStarts);
      const startsByTone = { calm: [], tense: [], shaken: [] };
      const startWeightsByTone = { calm: [], tense: [], shaken: [] };
      for (let s = 0; s < nStarts; s++) {
        const start = new Array(order);
        for (let j = 0; j < order; j++) start[j] = vocab[readStartWord()];
        const wt = readStartW();
        const toneId = bytes[startsToneOffset + s];
        const toneName = TONE_NAMES[toneId] || "calm";
        starts[s] = start;
        startWeights[s] = wt;
        startsByTone[toneName].push(start);
        startWeightsByTone[toneName].push(wt);
      }
      const trans = Object.create(null);
      for (let i = 0; i < nStates; i++) {
        const state = new Array(order);
        for (let j = 0; j < order; j++) state[j] = vocab[readStateWord()];
        const fan = readStateFan();
        const list = new Array(fan);
        for (let j = 0; j < fan; j++) {
          list[j] = [vocab[readNextWord()], readNextCount()];
        }
        trans[state.join(" ")] = list;
      }
      let bigramBackoff = buildBigramBackoff(trans, order);
      if (version === 7) {
        const readBackStateWord = readers[7];
        const readBackStateFan = readers[8];
        const readBackNextWord = readers[9];
        const readBackNextCount = readers[10];
        bigramBackoff = Object.create(null);
        for (let i = 0; i < nBackoff; i++) {
          const backKey = vocab[readBackStateWord()] + " " + vocab[readBackStateWord()];
          const fan = readBackStateFan();
          const list = new Array(fan);
          for (let j = 0; j < fan; j++) {
            list[j] = [vocab[readBackNextWord()], readBackNextCount()];
          }
          bigramBackoff[backKey] = list;
        }
      }
      return {
        order,
        starts,
        startWeights,
        startsByTone,
        startWeightsByTone,
        trans,
        bigramBackoff,
      };
    }

    const nStarts = vi();
    const nStartGroups = vi();
    const nGroups = vi();
    const colLens = new Array(11);
    for (let i = 0; i < 11; i++) colLens[i] = vi();
    function makeReader(start) {
      let q = start;
      return function () {
        let result = 0, shift = 0, b;
        for (;;) {
          b = bytes[q++];
          result |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) return result >>> 0;
          shift += 7;
        }
      };
    }
    let off = p;
    const readers = new Array(11);
    const colOffsets = new Array(11);
    for (let i = 0; i < 11; i++) {
      colOffsets[i] = off;
      readers[i] = makeReader(off);
      off += colLens[i];
    }
    const [
      readSgDw1, readSgN, readSgDw2,
      readGDw1, readGN, readEDw2, readEFan,
      readNDnext, readNCount,
      readStartsW, /* readStartsTone */
    ] = readers;
    // Tone tags are stored as one raw byte per start, so we don't go
    // through a varint reader — read directly off the byte array
    // using the column offset.
    const startsToneOffset = colOffsets[10];

    const starts = new Array(nStarts);
    const startWeights = new Array(nStarts);
    const startsByTone = { calm: [], tense: [], shaken: [] };
    const startWeightsByTone = { calm: [], tense: [], shaken: [] };
    let prevStartW1 = 0;
    let s = 0;
    for (let g = 0; g < nStartGroups; g++) {
      prevStartW1 += readSgDw1();
      const nEntries = readSgN();
      let prevStartW2 = 0;
      for (let i = 0; i < nEntries; i++) {
        prevStartW2 += readSgDw2();
        const start = [vocab[prevStartW1], vocab[prevStartW2]];
        const wt = readStartsW();
        const toneId = bytes[startsToneOffset + s];
        const toneName = TONE_NAMES[toneId] || "calm";
        starts[s] = start;
        startWeights[s] = wt;
        startsByTone[toneName].push(start);
        startWeightsByTone[toneName].push(wt);
        s++;
      }
    }

    const trans = Object.create(null);
    let gw1 = 0;
    for (let g = 0; g < nGroups; g++) {
      gw1 += readGDw1();
      const w1 = vocab[gw1];
      const nEntries = readGN();
      let ew2 = 0;
      for (let e = 0; e < nEntries; e++) {
        ew2 += readEDw2();
        const w2 = vocab[ew2];
        const fan = readEFan();
        const list = new Array(fan);
        let nxt = 0;
        for (let j = 0; j < fan; j++) {
          nxt += readNDnext();
          list[j] = [vocab[nxt], readNCount()];
        }
        trans[`${w1} ${w2}`] = list;
      }
    }
    return {
      order: 2,
      starts,
      startWeights,
      startsByTone,
      startWeightsByTone,
      trans,
      bigramBackoff: null,
    };
  }

  function init(bytes) {
    if (!bytes || !bytes.length) {
      throw new Error("Markov.init: empty model bytes");
    }
    model = parseModelBinary(bytes);
    ready = true;
    return model;
  }

  // Load per-act metadata from the parsed JSON section ("act").
  // Stores starts_by_act, weights_by_act, act_trans, act_lex.
  // Called by main.js after the payload is decoded.
  function initAct(json) {
    if (!json) return;
    actMeta = {
      startsByAct:   json.starts_by_act   || {},
      weightsByAct:  json.start_weights_by_act || {},
      actTrans:      json.act_trans        || {},
      actLex:        json.act_lex          || {},
    };
  }

  // Given a requested act and tone, return the best start pool.
  // Priority: (act ∩ tone) > act-only > tone-only > global.
  // Each fallback needs at least 5 starts to qualify; this prevents
  // a tiny intersection pool from locking every line into the same
  // handful of openers.
  function poolForActAndTone(act, tone, toneChance, actChance) {
    const MIN_POOL = 5;
    // Build per-act pool (flat, no tone filter)
    const actPool    = actMeta && act && actMeta.startsByAct[act]  || [];
    const actWeights = actMeta && act && actMeta.weightsByAct[act] || [];
    // Build per-tone pool
    const { pool: tonePool, weights: toneWeights } = poolForTone(tone, toneChance);

    // Try act intersection with tone if both are requested and pools are big enough
    if (act && actPool.length >= MIN_POOL
        && tone && toneChance > 0 && Math.random() < (actChance || 0.7)) {
      // Intersect: keep only starts that appear in the tone-tagged set
      let lookup = tone === "uneasy" ? "tense" : tone;
      const toneSet = new Set(
        (model.startsByTone && model.startsByTone[lookup] || [])
          .map(s => s.join(" "))
      );
      const intersectPool = [], intersectW = [];
      for (let i = 0; i < actPool.length; i++) {
        if (toneSet.has(actPool[i].join(" "))) {
          intersectPool.push(actPool[i]);
          intersectW.push(actWeights[i]);
        }
      }
      if (intersectPool.length >= MIN_POOL) {
        return { pool: intersectPool, weights: intersectW };
      }
    }
    // Fall back to act-only pool
    if (act && actPool.length >= MIN_POOL
        && Math.random() < (actChance || 0.7)) {
      return { pool: actPool, weights: actWeights };
    }
    // Fall back to tone pool (existing behaviour)
    return { pool: tonePool, weights: toneWeights };
  }

  // Sample the next dialogue act given the previous one.
  // Returns one of ACT_NAMES using the act_trans probability row.
  // Falls back to "chatter" if no actMeta loaded.
  function chooseAct(prevAct) {
    if (!actMeta || !actMeta.actTrans) return "chatter";
    const row = actMeta.actTrans[prevAct] || actMeta.actTrans["chatter"];
    if (!row) return "chatter";
    let total = 0;
    for (const act of ACT_NAMES) total += (row[act] || 0);
    let r = Math.random() * total;
    for (const act of ACT_NAMES) {
      r -= (row[act] || 0);
      if (r <= 0) return act;
    }
    return "chatter";
  }

  // Return the act_lex word list for a given act (empty array if unknown).
  function actLexFor(act) {
    return (actMeta && actMeta.actLex && actMeta.actLex[act]) || [];
  }

  function weightedPick(items, temperature) {
    // items: [[word, count], ...]
    // `temperature` (0 < t <= 1) flattens the distribution: at t=1 we
    // sample proportional to raw counts (default behaviour); at t<1 we
    // raise each count to that power, which softens the bias toward
    // the few super-common bigrams ("i think", "you know", …) and
    // gives the long tail of legitimate continuations a real chance.
    const t = temperature == null ? 1 : temperature;
    let total = 0;
    if (t === 1) {
      for (let i = 0; i < items.length; i++) total += items[i][1];
      let r = Math.random() * total;
      for (let i = 0; i < items.length; i++) {
        r -= items[i][1];
        if (r <= 0) return items[i][0];
      }
      return items[items.length - 1][0];
    }
    const weights = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const w = Math.pow(items[i][1], t);
      weights[i] = w;
      total += w;
    }
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i][0];
    }
    return items[items.length - 1][0];
  }

  // Pick one element of `pool` with weight `weights[i] ** flatten`.
  // flatten=1.0 → exactly proportional to raw weight (heaviest opener
  //               wins almost every time, like sampling uniformly
  //               over occurrences in the corpus);
  // flatten=0.5 → square-root: heavy starts still favoured but the
  //               long tail gets real airtime;
  // flatten=0.0 → uniform over UNIQUE starts.
  // Production sits around 0.4–0.5 — enough to break the chain's
  // tendency to land on the same handful of common openers every
  // single batch without losing the corpus's natural mass entirely.
  function flatWeightedChoice(pool, weights, flatten) {
    if (!pool.length) return null;
    if (flatten === 0) return pool[Math.floor(Math.random() * pool.length)];
    let total = 0;
    const ws = new Array(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const w = weights[i] || 1;
      const v = Math.pow(w < 1 ? 1 : w, flatten);
      ws[i] = v;
      total += v;
    }
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= ws[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  // Resolve the (pool, weights) pair for a given tone request.
  // tone === null/undefined → the global pool always.
  // tone matched, roll succeeds → the tone-tagged pool.
  // Otherwise fall back to the global pool.  This keeps generation
  // working when the trainer didn't tag any starts for a tone.
  function poolForTone(tone, toneChance) {
    // Pre-wave "uneasy" tone reuses the trained tense pool — the
    // corpus only has calm / tense / shaken tags, but the dialog
    // layer asks for "uneasy" during the alarm telegraph window.
    // Aliasing keeps the lines apprehensive without needing a
    // dedicated model.
    let lookup = tone;
    if (lookup === "uneasy") lookup = "tense";
    if (lookup && toneChance > 0
        && model.startsByTone && model.startsByTone[lookup]
        && model.startsByTone[lookup].length
        && Math.random() < toneChance) {
      return {
        pool: model.startsByTone[lookup],
        weights: model.startWeightsByTone[lookup],
      };
    }
    return { pool: model.starts, weights: model.startWeights };
  }

  // `topic` may be:
  //   - null/undefined → pick any start by flattened weight.
  //   - string         → prefer starts whose first word matches.
  //   - array          → pick a random seed from the array each call,
  //                      then prefer starts whose first word matches.
  // Falling back to "any start" when a seed has zero matches keeps
  // generation alive even when the caller asks for an exotic opener
  // the corpus never produced.
  function chooseStart(topic, tone, toneChance, startFlatten, act, actChance) {
    const { pool, weights } = (act && actMeta)
      ? poolForActAndTone(act, tone, toneChance, actChance)
      : poolForTone(tone, toneChance);
    if (topic == null) return flatWeightedChoice(pool, weights, startFlatten);
    let seed = topic;
    if (Array.isArray(topic)) {
      if (!topic.length) return flatWeightedChoice(pool, weights, startFlatten);
      seed = topic[Math.floor(Math.random() * topic.length)];
      if (seed == null) return flatWeightedChoice(pool, weights, startFlatten);
    }
    const matchPool = [];
    const matchWeights = [];
    for (let i = 0; i < pool.length; i++) {
      if (pool[i][0] === seed) {
        matchPool.push(pool[i]);
        matchWeights.push(weights[i]);
      }
    }
    if (matchPool.length) {
      return flatWeightedChoice(matchPool, matchWeights, startFlatten);
    }
    return flatWeightedChoice(pool, weights, startFlatten);
  }

  function isClean(tokens) {
    for (let i = 0; i < tokens.length; i++) {
      if (BANNED.has(bannedKey(tokens[i]))) return false;
    }
    return true;
  }

  // Mirrors the audit's is_dead_end: strips trailing terminators /
  // soft breaks, then checks the trailing word against DEAD_END_TAILS
  // or against SUBJECT_TAILS (only flagged on long lines).  Used as a
  // belt-and-braces check on *finished* sentences too — without this
  // the chain sometimes happily closes "Anyway, I could." or
  // "Cold. Said he couldn't do it on?" because the terminator was
  // legal at the previous bigram.
  function looksDeadEnd(tokens) {
    let i = tokens.length - 1;
    while (i >= 0
        && (SENTENCE_END.has(tokens[i]) || SOFT_BREAK.has(tokens[i]))) {
      i--;
    }
    if (i < 0) return false;
    const last = tokens[i].toLowerCase();
    if (DEAD_END_TAILS.has(last)) return true;
    if (SUBJECT_TAILS.has(last)) {
      let words = 0;
      for (let j = 0; j <= i; j++) {
        if (!SENTENCE_END.has(tokens[j]) && !SOFT_BREAK.has(tokens[j])) words++;
      }
      if (words > SUBJECT_TAIL_MAX_LEN) return true;
    }
    return false;
  }

  function hasBadLoop(tokens) {
    let run = 1;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === tokens[i - 1] && !SENTENCE_END.has(tokens[i]) && !SOFT_BREAK.has(tokens[i])) {
        run++;
        if (run >= 3) return true;
      } else {
        run = 1;
      }
    }
    const words = [];
    for (let i = 0; i < tokens.length; i++) {
      if (!SENTENCE_END.has(tokens[i]) && !SOFT_BREAK.has(tokens[i])) words.push(tokens[i].toLowerCase());
    }
    if (words.length >= 6) {
      for (let i = 0; i <= words.length - 6; i++) {
        if (words[i] === words[i + 2] && words[i] === words[i + 4]
            && words[i + 1] === words[i + 3] && words[i + 1] === words[i + 5]) {
          return true;
        }
      }
    }
    return false;
  }

  function generate(options) {
    if (!ready) return "hello?";
    options = options || {};
    const maxWords = options.maxWords != null ? options.maxWords : 14;
    const minWords = options.minWords != null ? options.minWords : 5;
    const topic = options.topic != null ? options.topic : null;
    const temperature = options.temperature != null ? options.temperature : 1.0;
    // Optional callers' anti-repetition memory.  `avoidStarts` is a
    // Set of "w1 w2" opening keys we should reject; `avoidTexts` is a
    // Set of full formatted sentences we already used recently.  We
    // try several alternatives before giving up — if everything keeps
    // colliding we still return a sentence rather than nothing.
    const avoidStarts = options.avoidStarts || null;
    const avoidTexts = options.avoidTexts || null;
    const attempts = options.attempts != null ? options.attempts : 32;
    // Tone-conditioned start sampling: the trainer tags every opener
    // as calm / tense / shaken; when the caller gives us a `tone`
    // and a `toneChance` > 0, we draw from the matching bucket with
    // that probability.
    const tone = options.tone != null ? options.tone : null;
    const toneChance = options.toneChance != null ? options.toneChance : 0.0;
    // Flattening exponent applied to per-start weights.  See
    // flatWeightedChoice() for the curve; 0.5 is the production
    // default — enough to give the long tail real airtime without
    // turning the corpus into a uniform draw.
    const startFlatten = options.startFlatten != null
      ? options.startFlatten : 0.5;
    // End-bias: within `endBiasWindow` words of `maxWords`, multiply
    // the weights of sentence terminators (.!?) by `endBiasStrength`
    // so the chain prefers to *close* rather than be force-truncated
    // mid-clause.  Without this we get a steady ~12-15% rate of
    // "...the." style endings.
    const endBiasWindow = options.endBiasWindow != null
      ? options.endBiasWindow : 3;
    const endBiasStrength = options.endBiasStrength != null
      ? options.endBiasStrength : 2.0;
    // Mid-chain tone reweighting: when generating for a tense or
    // shaken scene, multiply the count of any continuation that
    // appears in the matching tone lexicon by `toneBoost`.  Same
    // shape as endBiasStrength.  At 1.6-1.8 the chain noticeably
    // pulls toward tone vocabulary mid-sentence without going
    // off-rails into pure keyword soup.  Set <= 1.0 to disable.
    const toneBoost = options.toneBoost != null
      ? options.toneBoost : 1.0;
    let toneSet = null;
    if (toneBoost > 1.0) {
      let toneKey = tone;
      if (toneKey === "uneasy") toneKey = "tense";
      toneSet = TONE_LEX[toneKey] || null;
    }
    // Lex boost: same shape as toneBoost but for an arbitrary set
    // of "preferred mid-chain words" the caller supplies (eg. a
    // per-character content lexicon).  Kept separate from `topic`
    // because `topic` steers start selection — we don't want lex
    // words like "axe" or "fire" pulling openers.
    const lexBoost = options.lexBoost != null
      ? options.lexBoost : 1.0;
    let lexSet = null;
    if (lexBoost > 1.0 && Array.isArray(options.lex) && options.lex.length) {
      lexSet = new Set(options.lex);
    }
    // Quality filter: when generation runs to maxWords without hitting
    // a terminator, peek at the trailing token; reject if it's a
    // dead-end ("for the.") or a long-line subject pronoun ("...you.").
    // Better to retry than to ship a force-truncated bubble.
    const qualityFilter = options.qualityFilter !== false;

    // Act-conditioned start selection and mid-chain actBoost.
    // `act` — requested dialogue act (one of ACT_NAMES or null).
    // `actChance` — probability of using the act-filtered start pool
    //               (default 0.7, same structure as toneChance).
    // `actBoost` — multiplier for continuations in the act lexicon
    //              (analogous to toneBoost; default 1.0 = off).
    const act = options.act || null;
    const actChance = options.actChance != null ? options.actChance : 0.7;
    const actBoost = options.actBoost != null ? options.actBoost : 1.0;
    let actBoostSet = null;
    if (actBoost > 1.0 && act) {
      const words = actLexFor(act);
      if (words.length) actBoostSet = new Set(words);
    }

    let fallback = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const start = chooseStart(topic, tone, toneChance, startFlatten,
                                act, actChance);
      const startKey = `${start[0]} ${start[1]}`;
      // Stranded subordinator-style openers ("long as", "which is",
      // "even if") almost always run into a fragment in dialog; the
      // rejected attempt costs nothing (we just spin again) and the
      // bubble reads cleaner without them.
      if (FRAGMENT_STARTS.has(startKey)) continue;
      const isStartFresh = !avoidStarts || !avoidStarts.has(startKey);
      const out = start.slice();
      const order = model.order || 2;
      let finished = false;
      while (out.length < maxWords) {
        const key = out.slice(-order).join(" ");
        let nexts = model.trans[key];
        let backoffNexts = null;
        if (model.bigramBackoff && out.length >= 2) {
          const backoffKey = `${out[out.length - 2]} ${out[out.length - 1]}`;
          backoffNexts = model.bigramBackoff[backoffKey];
        }
        if ((!nexts || !nexts.length) && backoffNexts && backoffNexts.length) {
          nexts = backoffNexts;
        } else if (order > 2 && nexts && nexts.length
                   && backoffNexts && backoffNexts.length) {
          // Selective-trigram + interpolated backoff: blend the two
          // distributions instead of letting the trigram fully shadow
          // the bigram.  Smooths thin trigram states without losing
          // their local context advantage.
          nexts = interpolateDist(nexts, backoffNexts, INTERP_LAMBDA);
        }
        if (!nexts || !nexts.length) break;
        // BANNED-word filter inline so we don't have to allocate a
        // filtered copy on every step in the common (no-banned) case.
        let allowed = nexts;
        let hasBan = false;
        for (let i = 0; i < nexts.length; i++) {
          if (BANNED.has(bannedKey(nexts[i][0]))) { hasBan = true; break; }
        }
        if (hasBan) {
          allowed = [];
          for (let i = 0; i < nexts.length; i++) {
            if (!BANNED.has(bannedKey(nexts[i][0]))) allowed.push(nexts[i]);
          }
          if (!allowed.length) break;
        }
        // End-bias: as we approach maxWords, juice terminator
        // candidates so the chain prefers to *close* rather than be
        // force-truncated mid-clause.
        let pickPool = allowed;
        if (out.length >= minWords
            && out.length >= maxWords - endBiasWindow) {
          let needsBias = false;
          for (let i = 0; i < allowed.length; i++) {
            if (SENTENCE_END.has(allowed[i][0])) { needsBias = true; break; }
          }
          if (needsBias) {
            pickPool = new Array(allowed.length);
            for (let i = 0; i < allowed.length; i++) {
              const w = allowed[i][0];
              pickPool[i] = SENTENCE_END.has(w)
                ? [w, allowed[i][1] * endBiasStrength]
                : allowed[i];
            }
          }
        }
        // Tone-boost: gently pull the chain toward tone-vocabulary
        // mid-sentence.  Cheap, complementary to start tone-tagging.
        if (toneSet) {
          let needsToneBias = false;
          for (let i = 0; i < pickPool.length; i++) {
            if (toneSet.has(pickPool[i][0])) { needsToneBias = true; break; }
          }
          if (needsToneBias) {
            const next = new Array(pickPool.length);
            for (let i = 0; i < pickPool.length; i++) {
              const w = pickPool[i][0];
              next[i] = toneSet.has(w)
                ? [w, pickPool[i][1] * toneBoost]
                : pickPool[i];
            }
            pickPool = next;
          }
        }
        // Lex-boost: same idea, for a caller-supplied per-character
        // content lexicon.  Multiplies after tone-boost so they stack
        // — a tense scene with a "viking" speaker can lift "axe" via
        // lexBoost AND "fight" via toneBoost on the same step.
        if (lexSet) {
          let needsLexBias = false;
          for (let i = 0; i < pickPool.length; i++) {
            if (lexSet.has(pickPool[i][0])) { needsLexBias = true; break; }
          }
          if (needsLexBias) {
            const next = new Array(pickPool.length);
            for (let i = 0; i < pickPool.length; i++) {
              const w = pickPool[i][0];
              next[i] = lexSet.has(w)
                ? [w, pickPool[i][1] * lexBoost]
                : pickPool[i];
            }
            pickPool = next;
          }
        }
        // Act-boost: stacks after lex-boost, same structure.
        // Gently pulls the mid-chain toward the act lexicon so e.g.
        // an "ask" line is a bit more likely to contain question-y
        // content words (know/think/about/want) even past the first word.
        if (actBoostSet) {
          let needsActBias = false;
          for (let i = 0; i < pickPool.length; i++) {
            if (actBoostSet.has(pickPool[i][0])) { needsActBias = true; break; }
          }
          if (needsActBias) {
            const next = new Array(pickPool.length);
            for (let i = 0; i < pickPool.length; i++) {
              const w = pickPool[i][0];
              next[i] = actBoostSet.has(w)
                ? [w, pickPool[i][1] * actBoost]
                : pickPool[i];
            }
            pickPool = next;
          }
        }
        const next = weightedPick(pickPool, temperature);
        out.push(next);
        if (SENTENCE_END.has(next) && out.length >= minWords) {
          finished = true;
          break;
        }
      }
      // Quality filter only applies when we ran out of words without
      // a clean terminator — a finished sentence already ends on .!?.
      if (qualityFilter && !finished) {
        while (out.length && SOFT_BREAK.has(out[out.length - 1])) {
          out.pop();
        }
        if (out.length) {
          const lastLower = out[out.length - 1].toLowerCase();
          if (DEAD_END_TAILS.has(lastLower)) continue;
          if (SUBJECT_TAILS.has(lastLower)
              && out.length > SUBJECT_TAIL_MAX_LEN) continue;
        }
      }
      if (!finished) {
        const last = out[out.length - 1];
        if (!SENTENCE_END.has(last)) out.push(".");
      }
      if (!isClean(out)) continue;
      if (qualityFilter && hasBadLoop(out)) continue;
      // Belt-and-braces: a sentence that *did* terminate cleanly can
      // still land on "Anyway, I could." or end a question on a
      // dangling preposition.  Re-run the dead-end check on the
      // finished tokens, not just the open clause, so these never
      // reach the bubble.
      if (qualityFilter && looksDeadEnd(out)) continue;
      const text = formatSentence(out);
      if (text.split(" ").length < minWords) continue;
      const isTextFresh = !avoidTexts || !avoidTexts.has(text);
      if (isStartFresh && isTextFresh) return text;
      // Stash the first acceptable-but-stale candidate so we never
      // come back empty even when every attempt collides with recent
      // history.
      if (!fallback) fallback = text;
    }
    return fallback || "Well, anyway.";
  }

  // Word-count helper for smart end-punctuation: counts only "real"
  // tokens (drops punctuation), so "Hold the line." reports 3, not 4.
  function wordCount(tokens) {
    let n = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!SENTENCE_END.has(t) && !SOFT_BREAK.has(t)) n++;
    }
    return n;
  }

  function formatSentence(tokens) {
    let out = "";
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (SENTENCE_END.has(t) || SOFT_BREAK.has(t)) {
        out += t;
      } else if (out === "") {
        out += t;
      } else {
        out += " " + t;
      }
    }
    out = out.charAt(0).toUpperCase() + out.slice(1);
    out = out.replace(/\bi\b/g, "I").replace(/\bi'/g, "I'");

    // Smart end-punctuation: the chain almost always closes with `.`,
    // but openers like "Are you …", "Where's …", "Haven't I …" read
    // as typos when terminated with `.`; short imperatives like
    // "Hold the line." land harder as `!`.  Only swap when the chain
    // (or our fallback) wrote `.` — never override a real `?`/`!`.
    if (out.length && out[out.length - 1] === ".") {
      const first = (tokens[0] || "").toLowerCase();
      if (QUESTION_STARTERS.has(first)) {
        out = out.slice(0, -1) + "?";
      } else if (IMPERATIVE_STARTERS.has(first)
                 && wordCount(tokens) <= SHORT_IMPERATIVE_MAX_LEN) {
        out = out.slice(0, -1) + "!";
      }
    }
    return out;
  }

  return { init, initAct, generate, chooseAct, actLexFor,
           isReady: () => ready };
})();
