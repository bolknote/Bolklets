/*
 * Runs a short conversation between two characters.
 *
 * Conversation structure (hybrid: curated framing + Markov small-talk):
 *
 *   greeting A  (curated friendly line)
 *   greeting B  (curated response)
 *   small talk A (Markov)
 *   small talk B (Markov)
 *   small talk A (Markov, optional)
 *   farewell A  (curated)
 *   farewell B  (curated)
 *
 * Each bubble is shown long enough to read (≈40 chars/sec, clamped to
 * a minimum/maximum) with short gaps between lines so the exchange
 * feels like a real back-and-forth.
 */
const Dialog = (() => {
  // Hand-written greetings/farewells are now only the SAFETY NET.
  // The first attempt is always to grow one out of the Markov chain
  // with greeting/farewell-flavoured opener seeds so the lines feel
  // less "I have heard that exact line ten times already".
  const GREETINGS_A = [
    "Hey, fancy meeting you here!",
    "Oh hi! How's your day going?",
    "Well well, look who it is.",
    "Hello friend, got a minute?",
    "Howdy! Didn't expect to see you.",
  ];
  const GREETINGS_B = [
    "Hey yourself! Pretty good, you?",
    "Hi there, just doing my thing.",
    "Oh, hello! Nice to run into you.",
    "Hey! All good on my side.",
  ];
  const FAREWELLS_A = [
    "Anyway, I should get back to it.",
    "Well, duty calls. Take care!",
    "Nice chatting — see you around!",
    "Alright, gotta run. Bye!",
  ];
  const FAREWELLS_B = [
    "See you later, friend!",
    "Take care out there!",
    "Bye, catch you next time!",
    "Safe travels!",
  ];

  // Seed pools for Markov-generated lines.  The chain only honours
  // the FIRST word, so we nudge the opener toward the right register
  // (greeting / farewell / scene tone / per-character voice) and let the
  // rest of the sentence ride the corpus.  Bigger pools = much more
  // variety in line openings, which is the single biggest factor in
  // dialogue not feeling repetitive.
  const SMALLTALK_PROMPTS_CALM = [
    null, "you", "i", "did", "how", "what", "where", "this", "that",
    "so", "well", "maybe", "yeah", "oh", "the", "actually", "anyway",
    "honestly", "maybe", "remember", "speaking", "tell", "ever",
    "between", "funny", "still", "guess", "another", "who", "why",
    "kind", "today", "yesterday", "earlier", "look", "listen",
  ];
  const SMALLTALK_PROMPTS_TENSE = [
    "did", "they", "we", "watch", "where", "behind", "what", "you",
    "look", "careful", "stay", "keep", "is", "something", "did",
    "hold", "quiet", "down", "above", "around", "moving", "wait",
    "easy", "ready", "weapons", "eyes", "cover",
  ];
  const SMALLTALK_PROMPTS_SHAKEN = [
    "that", "almost", "close", "just", "alive", "what", "phew", "i",
    "we", "well", "oh", "if", "thank", "lucky", "another", "next",
    "never", "every", "still", "rest", "breathe", "safe",
  ];
  const TONE_DETECT = {
    tense: new Set(SMALLTALK_PROMPTS_TENSE.filter(Boolean)),
    shaken: new Set(SMALLTALK_PROMPTS_SHAKEN.filter(Boolean)),
  };
  // Question-aware reply seeding: when the previous bubble ends in `?`,
  // prepend a heavy block of answer-ish starters so the next line at
  // least OPENS like a reply ("Well, ...", "No, ...", "Because ...")
  // instead of jumping straight into an unrelated fragment.
  const ANSWER_OPENERS = [
    "yes", "no", "well", "maybe", "because", "sure", "i", "we",
    "actually", "honestly", "probably", "never", "always",
    "sometimes", "okay", "alright", "right", "true", "absolutely",
    "of", "kind", "sort", "definitely", "perhaps",
  ];
  const ANSWER_OPENERS_REPEAT = 6;
  const EXCLAIM_OPENERS = [
    "okay", "alright", "easy", "wait", "look", "listen", "right",
    "fine", "sure", "well", "no", "yes",
  ];
  const IMPERATIVE_REPLY_OPENERS = [
    "okay", "alright", "fine", "easy", "wait", "right", "sure",
    "listen", "look", "i", "we", "no",
  ];
  // Words that, when they open a SHORT line, are read as a command/
  // imperative ("Wait.", "Stay close.", "Watch the door!").  Used by
  // classifyPrevBeat to route the next speaker through
  // IMPERATIVE_REPLY_OPENERS instead of the generic answer pool, so a
  // bark like "Stay back!" gets a proper "Okay, okay…" reply rather
  // than a non-sequitur question.  The detector only fires on lines
  // up to SHORT_IMPERATIVE_MAX_LEN tokens — long sentences that
  // happen to start with one of these words are statements, not
  // commands.
  const IMPERATIVE_STARTERS = new Set([
    "wait", "stop", "look", "listen", "watch", "stay", "keep", "hold",
    "go", "come", "run", "move", "get", "drop", "duck", "down",
    "back", "behind", "follow", "find", "let", "tell", "show", "give",
    "take", "be", "stand", "hide", "quiet", "easy", "careful", "ready",
    "don't", "do", "leave", "bring", "open", "close", "shut", "stop",
    "help",
  ]);
  const SHORT_IMPERATIVE_MAX_LEN = 4;
  const ACK_OPENERS = [
    "yeah", "well", "right", "maybe", "actually", "honestly",
    "still", "so", "i", "we", "true", "perhaps",
  ];
  const AGREE_OPENERS = [
    "yes", "right", "sure", "agreed", "together", "done",
    "of", "absolutely", "fine", "good",
  ];
  const REFUSE_OPENERS = [
    "no", "not", "never", "save", "keep", "later",
    "pass", "decline", "cannot", "won't",
  ];
  const WARNING_OPENERS = [
    "careful", "watch", "stay", "keep", "listen",
    "behind", "quiet", "easy", "look", "move",
  ];
  const PROMISE_OPENERS = [
    "i", "we", "together", "trust", "stay",
    "with", "on", "promise", "alright", "right",
  ];
  const BEAT_OPENERS_REPEAT = 4;
  const ANCHOR_PICKS = 2;
  const ANCHOR_REPEAT = 3;
  const ANCHOR_MAX = 6;
  const OPENER_RERANK_CANDIDATES = 4;
  const SMALLTALK_LOOKAHEAD_TOPK = 3;
  const SMALLTALK_LOOKAHEAD_WEIGHT = 0.45;

  // Opener seed pools used for greeting/farewell lines.  The Markov
  // chain has plenty of "Hey, …" / "Hi …" / "See you …" sentence
  // starts in the Cornell movie corpus, so seeding with these lets
  // us replace the tiny canned banks with a near-endless supply of
  // organic openers.
  const GREETING_OPENERS = [
    "hey", "hi", "hello", "oh", "well", "look", "fancy", "good",
    "morning", "afternoon", "listen", "you", "so", "what", "how",
    "long", "haven't", "didn't", "is", "are", "nice",
  ];
  const FAREWELL_OPENERS = [
    "see", "bye", "take", "alright", "gotta", "well", "catch",
    "until", "goodnight", "goodbye", "stay", "keep", "mind", "look",
    "you", "be", "i'll", "i'd", "let's", "anyway", "okay",
  ];

  // Per-character voice overlay.  We sprinkle a few role/name-flavoured
  // seed words on top of the tone pool whenever a hero opens their
  // mouth, so the alien doesn't sound like the witch and the healer
  // doesn't sound like the bruiser.  Markov only sees the first word
  // — that's enough to colour the opener and, by knock-on bigram
  // effects, the next few words too.
  const VOICE_BY_NAME = {
    alien:    ["scanning", "earthling", "specimen", "calculating",
               "transmission", "negative", "affirmative", "primitive",
               "human", "my", "we", "your"],
    witch:    ["once", "long", "they", "old", "strange", "magic",
               "the", "beware", "between", "i", "shadows", "dark"],
    firemage: ["fire", "burn", "the", "bright", "warm", "hot",
               "i", "ash", "flames"],
    knight:   ["honour", "by", "the", "stand", "for", "i", "today",
               "my", "we", "loyalty", "duty"],
    archer:   ["steady", "quiet", "i", "the", "from", "draw",
               "always", "watch", "above", "wind"],
    viking:   ["ha", "by", "the", "drink", "another", "more",
               "tonight", "my", "axe", "we", "blood"],
    zombie:   ["uh", "hungry", "brains", "tired", "warm", "cold",
               "mmm", "where", "what"],
    robot:    ["beep", "boop", "system", "status", "running",
               "input", "data", "logic", "negative", "affirmative"],
    ninja:    ["shh", "quiet", "i", "from", "shadow", "the",
               "swift", "silent", "watch"],
    girl:     ["please", "oh", "my", "let", "thank", "i", "we",
               "everyone", "kindly", "here"],
  };
  const VOICE_BY_ROLE = {
    healer:  ["please", "oh", "let", "kindly", "we", "be", "stay"],
    alien:   ["scanning", "specimen", "negative", "affirmative", "we"],
    fighter: ["i", "we", "the", "by", "next", "another", "hold"],
  };
  function voiceSeeds(c) {
    if (!c) return [];
    const a = VOICE_BY_NAME[c.name] || [];
    const b = VOICE_BY_ROLE[c.role] || [];
    return a.concat(b);
  }

  // Per-character CONTENT lexicon — words that *colour the body*, not
  // just the opener.  VOICE_BY_NAME above is "what does this character
  // tend to start their line with"; LEX_BY_NAME is "what content
  // words make this character feel like themselves anywhere in the
  // line".  They overlap deliberately, but LEX_BY_NAME is the place
  // we put the longer, distinctive nouns/verbs we want to score and
  // seed by — without polluting the start-word bias.
  //
  // Used in three places:
  //   1. seedsForSmalltalk: lex words get pushed in with a small
  //      front-of-pool repeat so the chain has a real chance to land
  //      on them after the opener. (mid-sentence content word, not
  //      first-word opener.)
  //   2. scoreSmalltalkCandidate: per-character lex hits score a
  //      bigger bonus than the existing voiceSeeds hit, and we count
  //      up to two hits.
  //   3. chooseVoicePrefix: if the body already contains lex words,
  //      we *skip* the prefix — the body is already in-character so
  //      stamping "Beep." or "By my axe!" on top of it would feel
  //      forced.  Conversely, if the body has zero lex hits and the
  //      character has a high voice-strength, we BOOST the prefix
  //      chance to compensate.
  const LEX_BY_NAME = {
    alien: [
      "scanning", "specimen", "earthling", "transmission", "calculating",
      "primitive", "negative", "affirmative", "sensors", "lifeform",
      "analysis", "data", "frequency", "signal", "detect", "detected",
      "humanoid", "biology", "scan", "scanned",
    ],
    witch: [
      "shadow", "shadows", "old", "ancient", "magic", "spell", "spells",
      "moon", "moonlight", "cauldron", "spirits", "stars", "fate",
      "whisper", "whispers", "between", "darkness", "long", "ago",
      "tides", "warning", "warned",
      "potion", "potions", "brew", "brews", "brewing", "bottle", "bottles",
      "herb", "herbs", "elixir", "mixture", "infusion", "charm", "charms",
      "kettle", "distill", "steep",
    ],
    firemage: [
      "fire", "flame", "flames", "burn", "burning", "burned", "ash",
      "ashes", "ember", "embers", "hot", "bright", "spark", "blaze",
      "smoke", "scorch", "warmth", "kindling", "torch",
    ],
    knight: [
      "honour", "duty", "oath", "loyalty", "shield", "stand", "valor",
      "realm", "guard", "protect", "vow", "noble", "defend", "lance",
      "armor", "field", "battle", "for",
    ],
    archer: [
      "arrow", "bow", "draw", "wind", "watch", "above", "below",
      "steady", "quiet", "target", "range", "above", "shot", "feather",
      "string", "quiver", "still", "patient",
    ],
    viking: [
      "axe", "drink", "mead", "blood", "feast", "tonight", "another",
      "round", "fight", "thunder", "battle", "boats", "raid", "shout",
      "skol", "odin", "valhalla", "horn",
    ],
    zombie: [
      "brains", "hungry", "warm", "cold", "tired", "groan", "moan",
      "fresh", "smell", "taste", "slow", "long",
    ],
    robot: [
      "system", "status", "input", "data", "logic", "compute", "running",
      "diagnostic", "negative", "affirmative", "circuit", "memory",
      "boot", "process", "module", "command",
    ],
    ninja: [
      "shadow", "shadows", "silent", "swift", "watch", "blade", "strike",
      "smoke", "moon", "rooftop", "patient", "wind", "still",
      "quiet", "mark",
    ],
    girl: [
      "please", "kindly", "thank", "everyone", "together", "share",
      "kind", "dear", "lovely", "warm", "home", "garden", "flowers",
      "song", "song",
    ],
  };
  // How many copies of each lex pick we push into the seed pool.  The
  // seed-pool sampler is uniform over slots, so duplicating a lex
  // word ~3× pulls the chain toward it without crowding out tone /
  // continuity / anchor seeds.
  const LEX_PICKS = 2;
  const LEX_REPEAT = 3;

  function lexFor(speaker) {
    if (!speaker) return [];
    return LEX_BY_NAME[speaker.name] || [];
  }

  function lexHitCount(speaker, toks) {
    const lex = lexFor(speaker);
    if (!lex.length || !toks.length) return 0;
    const set = new Set(lex);
    let hits = 0;
    for (let i = 0; i < toks.length; i++) {
      if (set.has(toks[i])) hits++;
    }
    return hits;
  }

  // Per-character "voice strength" — probability that we draw a
  // voice-only seed pool for this speaker instead of blending the
  // voice with the current scene tone.  Distinctive archetypes
  // (alien, robot, viking) get high values so their bubbles really
  // do open with "scanning" / "beep" / "by my axe" most of the
  // time; the more neutral fighters (knight, ninja) lean lower so
  // they don't sound forced.  These numbers were bumped after the
  // post-v4 experiment pass: the earlier values under-served voice
  // flavour in the audit (too many "generic corpus" openers).
  const VOICE_STRENGTH = {
    alien: 0.85, robot: 0.85, zombie: 0.80, viking: 0.75,
    firemage: 0.65, witch: 0.55, ninja: 0.35, archer: 0.35,
    knight: 0.35, girl: 0.35,
  };

  // Per-character voice-prefix templates.  When a high-voice-strength
  // character speaks, with probability VOICE_PREFIX_CHANCE we prepend
  // a short signature prefix like "Beep." (robot) or "By my axe!"
  // (viking) and ask Markov for a slightly shorter body.  This is the
  // cheapest way to make distinctive characters actually SOUND
  // distinctive — the chain alone can't reliably produce "axe" or
  // "scanning" without a per-state intervention, but a tiny canned
  // prefix lets the voice land in the first beat the bubble pops.
  const VOICE_PREFIXES = {
    alien: [
      "Scanning.", "Affirmative.", "Negative.", "Calculating.",
      "Earthling,", "Specimen analysed:", "Transmission incoming:",
      "Bzzt.", "Primitive lifeform,", "My sensors confirm:",
    ],
    robot: [
      "Beep.", "Boop.", "Beep boop.", "System nominal.",
      "Status:", "Input received:", "Logic confirms:",
      "Negative.", "Affirmative.", "Running diagnostic.",
      "Compute complete.",
    ],
    zombie: [
      "Mmm.", "Uh.", "Brains.", "Hungry.",
      "Tired.", "Cold.", "Warm.",
    ],
    viking: [
      "Ha!", "By my axe!", "Another round!", "Drink!",
      "By the gods,", "Tonight we feast!", "Skol!",
      "By Odin's beard,", "More mead!",
    ],
    firemage: [
      "By the flame,", "Burn!", "Ash and embers,",
      "Fire takes everything.", "The flames whisper:",
      "Bright as the sun,",
    ],
    witch: [
      "Long ago,", "The shadows say,", "Beware,",
      "Between the worlds,", "Old magic warns:",
      "Strange tidings,",
    ],
    ninja: [
      "Shh.", "Hush.", "From the shadows,", "Silent as the wind,",
      "Watch.",
    ],
    girl: [
      "Oh!", "Please,", "Kindly,", "Bless you,", "Dear me,",
    ],
    knight: [
      "By my honour,", "On my oath,", "For the realm,",
      "Stand fast.", "Hold the line!",
    ],
    archer: [
      "Steady.", "Quiet, now.", "From above,", "Draw,",
    ],
  };
  const VOICE_PREFIX_CHANCE = {
    alien: 0.60, robot: 0.60, zombie: 0.50, viking: 0.45,
    firemage: 0.35, witch: 0.35, ninja: 0.25,
    knight: 0.20, archer: 0.20, girl: 0.25,
  };

  // Words we strip from a previous line when extracting "content"
  // tokens to seed the next speaker's reply.  Topic continuity is
  // weak in pure Markov ("everyone replies with statistically likely
  // words"), so threading 2-3 keywords from the previous bubble into
  // the next speaker's seed pool makes the back-and-forth feel a bit
  // more like an actual exchange.  The list is the usual function-
  // word + filler-word kit (articles, modal verbs, pronouns,
  // discourse markers) — small enough to be cheap to check on every
  // turn.
  const STOP = new Set([
    "the", "a", "an", "and", "or", "but", "if", "of", "for", "to",
    "with", "at", "on", "in", "by", "from", "as", "than", "so", "is",
    "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "shall", "should", "can",
    "could", "may", "might", "must", "i", "you", "he", "she", "it",
    "we", "they", "me", "him", "her", "us", "them", "my", "your",
    "his", "hers", "its", "our", "their", "this", "that", "these",
    "those", "what", "who", "which", "where", "when", "why", "how",
    "not", "no", "yes", "well", "oh", "okay", "ok", "yeah", "right",
    "just", "very", "now", "then", "there", "here", "all", "some",
    "any", "out", "up", "down", "off",
  ]);
  const CONTENT_MIN_LEN = 4;
  // How many distinct content words to lift from the previous line
  // when seeding the next speaker.  2 keeps the bias focused — three
  // gave too many duplicate "I think we should…" loops once continuity
  // got its weight bumped up in the loop below.
  const CONTINUITY_PICKS = 2;
  // How many copies of each continuity seed get pushed into the seed
  // pool.  Markov.chooseStart picks one seed uniformly from `topic`,
  // so duplicating each picked content word ~6× makes a content word
  // the opener-seed roughly half the time when the previous line had
  // any (was ~14% with the old "append once" approach), which is what
  // actually moves the topic-overlap metric.
  const CONTINUITY_REPEAT = 6;
  function contentWords(text) {
    if (!text) return [];
    const out = [];
    const re = /[a-z']+/g;
    let m;
    const lower = text.toLowerCase();
    while ((m = re.exec(lower)) !== null) {
      const w = m[0];
      if (w.length >= CONTENT_MIN_LEN && !STOP.has(w)) out.push(w);
    }
    return out;
  }

  function seedFront(pool, picks, repeat) {
    const out = [];
    if (!pool || !pool.length) return out;
    const take = Math.min(picks, pool.length);
    for (let i = 0; i < take; i++) {
      const w = pool[Math.floor(Math.random() * pool.length)];
      for (let r = 0; r < repeat; r++) out.push(w);
    }
    return out;
  }

  function classifyPrevBeat(text) {
    text = (text || "").trim();
    if (!text) return null;
    const words = wordTokens(text);
    if (!words.length) return null;
    const first = words[0];
    if (/\?\s*$/.test(text)) return "question";
    if (IMPERATIVE_STARTERS.has(first) && words.length <= SHORT_IMPERATIVE_MAX_LEN + 1) {
      return "imperative";
    }
    if (/!\s*$/.test(text)) return "exclaim";
    if (words.length <= 4) return "short";
    return "statement";
  }

  function beatOpenersFor(text) {
    const beat = classifyPrevBeat(text);
    if (beat === "question") return ANSWER_OPENERS;
    if (beat === "imperative") return IMPERATIVE_REPLY_OPENERS;
    if (beat === "exclaim") return EXCLAIM_OPENERS;
    if (beat === "short") return ACK_OPENERS;
    return null;
  }

  function classifyLineAct(text, framing) {
    text = (text || "").trim();
    if (!text) return null;
    if (framing === "greeting") return "greeting";
    if (framing === "farewell") return "farewell";
    const first = firstWordLower(text);
    if (/\?\s*$/.test(text)) return "question";
    if (GREETING_OPENERS.indexOf(first) !== -1) return "greeting";
    if (FAREWELL_OPENERS.indexOf(first) !== -1) return "farewell";
    if (ANSWER_OPENERS.indexOf(first) !== -1) return "answer";
    if (AGREE_OPENERS.indexOf(first) !== -1) return "agree";
    if (REFUSE_OPENERS.indexOf(first) !== -1) return "refuse";
    if (WARNING_OPENERS.indexOf(first) !== -1) return "warning";
    if (PROMISE_OPENERS.indexOf(first) !== -1 && /\b(with|together|trust|promise)\b/i.test(text)) {
      return "promise";
    }
    return "statement";
  }

  function actReplyOpenersFor(text) {
    const act = classifyLineAct(text);
    if (act === "question") return ANSWER_OPENERS;
    if (act === "warning") return ACK_OPENERS.concat(PROMISE_OPENERS);
    if (act === "agree") return AGREE_OPENERS;
    if (act === "refuse") return ACK_OPENERS.concat(REFUSE_OPENERS);
    if (act === "promise") return AGREE_OPENERS.concat(PROMISE_OPENERS);
    return null;
  }

  function makeAnchorState() {
    return { list: [], set: new Set() };
  }

  function updateAnchors(anchorState, text) {
    if (!anchorState) return;
    const fresh = [];
    const seen = anchorState.set;
    const words = contentWords(text);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!seen.has(w) && fresh.indexOf(w) === -1) fresh.push(w);
    }
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = fresh[i];
      fresh[i] = fresh[j];
      fresh[j] = tmp;
    }
    for (let i = 0; i < Math.min(ANCHOR_PICKS, fresh.length); i++) {
      const w = fresh[i];
      if (anchorState.set.has(w)) continue;
      anchorState.list.push(w);
      anchorState.set.add(w);
      while (anchorState.list.length > ANCHOR_MAX) {
        anchorState.set.delete(anchorState.list.shift());
      }
    }
  }

  function chooseVoicePrefix(speaker, policy) {
    if (!speaker) return null;
    const bank = VOICE_PREFIXES[speaker.name];
    if (!bank || !bank.length) return null;
    if (policy === "off") return null;
    if (policy === "on") return bank[Math.floor(Math.random() * bank.length)];
    const chance = VOICE_PREFIX_CHANCE[speaker.name] || 0.0;
    if (chance <= 0 || Math.random() >= chance) return null;
    return bank[Math.floor(Math.random() * bank.length)];
  }

  // Smart prefix gating: drops a candidate prefix when the body
  // already lands lex / voice hits — stamping "Beep." on top of a
  // line that already says "scanning the specimen now" would feel
  // forced.  We deliberately do NOT force-add prefixes here: doing
  // so concentrates openers on the tiny canned prefix bank and, more
  // importantly, breaks Q&A alignment when an answer-style body gets
  // a non-answer prefix bolted onto it.
  //
  // This is purely cosmetic — the chain still produces the body —
  // but it tightens the per-character feel without changing model
  // size or temperature.
  function gateVoicePrefix(speaker, prefix, body) {
    if (!prefix || !body) return prefix;
    const toks = wordTokens(body);
    if (!toks.length) return prefix;
    const lexHits = lexHitCount(speaker, toks);
    const voice = VOICE_BY_NAME[speaker && speaker.name] || [];
    let voiceHits = 0;
    if (voice.length) {
      const set = new Set(voice);
      for (let i = 0; i < toks.length; i++) {
        if (set.has(toks[i])) { voiceHits++; if (voiceHits >= 2) break; }
      }
    }
    if (lexHits >= 1 || voiceHits >= 2) return null;
    return prefix;
  }

  function openerFamily(text) {
    const first = firstWordLower(text);
    if (!first) return "";
    if (GREETING_OPENERS.indexOf(first) !== -1) return "greeting";
    if (FAREWELL_OPENERS.indexOf(first) !== -1) return "farewell";
    if (ANSWER_OPENERS.indexOf(first) !== -1) return "answer";
    if (WARNING_OPENERS.indexOf(first) !== -1) return "warning";
    return first;
  }

  function candidateRecipes(prevLine) {
    const recipes = [
      { name: "base" },
      { name: "cool", temperature: 0.58, prefixPolicy: "off" },
      { name: "hot", temperature: 0.82 },
      { name: "tone", voiceMode: "blend", toneFrontPicks: 2, toneFrontRepeat: 2 },
      { name: "voice", voiceMode: "voice", continuityBonusRepeat: 2 },
      { name: "continuity", voiceMode: "blend", continuityBonusRepeat: 3, prefixPolicy: "off" },
    ];
    if (prevLine && /\?\s*$/.test(prevLine)) {
      recipes[recipes.length - 1] = {
        name: "answer",
        voiceMode: "blend",
        answerBonusRepeat: 4,
        prefixPolicy: "off",
      };
    }
    return recipes;
  }
  // Lightweight scene-tone memory — a few timestamps of recent dramatic
  // events.  Anyone can poke them via `Dialog.note(kind)`.  We keep
  // this tiny on purpose; the goal is "feels reactive", not a real
  // emotion engine.
  const toneState = {
    lastHeroDownAt: 0,
    lastReviveAt: 0,
    lastMonsterKillAt: 0,
    // Set by Dialog.note("rumor") — Characters' gossip deal pokes
    // this whenever two heroes share spooky news, so the next few
    // seconds of small talk lean tense even if the lawn itself is
    // still calm.  Window is short (the lawn is fine, after all)
    // but long enough that the very next chat picks it up.
    lastRumorAt: 0,
    // Set by Dialog.note("alarm") — Director pings it ~1.5 s before
    // a monster wave actually spawns.  The brief window between the
    // ping and the wave reads as "uneasy" (a softer flavour than the
    // full-on monsters-on-screen "tense"), so chats already in flight
    // tighten up before the first claw lands.
    lastAlarmAt: 0,
  };
  function note(kind) {
    const t = performance.now();
    if (kind === "heroDown")    toneState.lastHeroDownAt    = t;
    else if (kind === "revive") toneState.lastReviveAt      = t;
    else if (kind === "kill")   toneState.lastMonsterKillAt = t;
    else if (kind === "rumor")  toneState.lastRumorAt       = t;
    else if (kind === "alarm")  toneState.lastAlarmAt       = t;
  }
  function currentTone() {
    const t = performance.now();
    if (typeof Monsters !== "undefined" && Monsters.count && Monsters.count() > 0) {
      return "tense";
    }
    if (t - toneState.lastHeroDownAt < 12000) return "shaken";
    if (t - toneState.lastReviveAt   < 8000)  return "shaken";
    if (t - toneState.lastMonsterKillAt < 6000) return "tense";
    if (t - toneState.lastRumorAt    < 14000) return "tense";
    // Pre-wave alarm window — softer than "tense" (no monsters yet)
    // but enough to nudge the tone away from calm small-talk.  Keep
    // a short-ish memory so the alarm only colours chats actually
    // straddling the "they're coming" beat, not the next minute of
    // quiet recovery once the wave's been cleared.
    if (t - toneState.lastAlarmAt    < 4000)  return "uneasy";
    return "calm";
  }
  function toneSeeds(toneOverride) {
    const t = toneOverride || currentTone();
    switch (t) {
      case "tense":  return SMALLTALK_PROMPTS_TENSE;
      case "shaken": return SMALLTALK_PROMPTS_SHAKEN;
      // "uneasy" is a softer pre-wave variant — share the tense
      // seed pool so chats lean toward apprehensive vocabulary
      // without needing a whole separate corpus.
      case "uneasy": return SMALLTALK_PROMPTS_TENSE;
      default:       return SMALLTALK_PROMPTS_CALM;
    }
  }

  // Pick the tone for one whole encounter (a single A↔B chat) so the
  // back-and-forth stays in one register instead of bouncing between
  // calm and tense per line.  Live scene state always wins — if the
  // world is currently tense or shaken, we honour it; only when the
  // scene is calm do we roll the dice and inject some variety so not
  // every quiet-time chat is dead-flat.  Mix mirrors the production
  // sweet spot: most chats stay calm (it's downtime), a quarter pick
  // up slightly tense vocabulary, the rest carry "we just survived"
  // energy.
  function pickEncounterTone(charA, charB) {
    const live = currentTone();
    if (live !== "calm") return live;
    // High mutual affinity = warmer chat: shift the calm/tense/shaken
    // mix toward calm, because friends having a chat read as relaxed
    // even after a spike of drama elsewhere on the lawn.  Negative
    // affinity does the opposite — strangers / past refusers pick up
    // a slightly more guarded register.
    let calmCut = 0.60, tenseCut = 0.85;
    if (charA && charB && typeof Characters !== "undefined"
        && Characters.affinityBetween) {
      const aff = Characters.affinityBetween(charA, charB);
      const shift = Math.max(-0.15, Math.min(0.20, aff * 0.04));
      calmCut  = Math.max(0.40, Math.min(0.85, calmCut + shift));
      tenseCut = Math.max(calmCut + 0.05, Math.min(0.95, tenseCut + shift * 0.5));
    }
    const r = Math.random();
    if (r < calmCut)  return "calm";
    if (r < tenseCut) return "tense";
    return "shaken";
  }

  const MIN_BUBBLE_MS = 1800;
  const MAX_BUBBLE_MS = 5500;
  const BETWEEN_LINES_MS = 500;

  function estimateReadingTime(text) {
    const ms = 600 + text.length * 55;
    return Math.max(MIN_BUBBLE_MS, Math.min(MAX_BUBBLE_MS, ms));
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // Anti-repetition memory shared across ALL conversations.  We keep
  // an LRU of recently used opening bigrams (e.g. "i think") and
  // recently uttered full sentences so two heroes chatting in the
  // corner don't echo a line another pair just said five seconds
  // ago.  The chain has plenty of variety; it just needs a nudge to
  // explore it.  The 200/320 caps come from the v4 audit sweep — at
  // 30/50 we got opener concentration; at 200/320 the openers
  // distribute over ~1100 unique bigram starts in a typical session.
  const RECENT_OPEN_KEEP = 200;
  const RECENT_TEXT_KEEP = 320;
  // Markov runtime defaults — these are the v4 audit-sweep winners.
  // Threaded into every Markov.generate() call below so smalltalk,
  // openers, and the post-thanks tail all share the same generation
  // shape.  Tweak in one place if we ever rerun the sweep.
  const MARKOV_DEFAULTS = {
    toneChance:      0.85,  // how often to draw from a tone-tagged opener
    startFlatten:    0.5,   // sub-linear weight^0.5 over start weights
    endBiasWindow:   3,     // last 3 words: bias toward terminators
    endBiasStrength: 2.0,   // by ×2 — discourages "...the." cuts
    qualityFilter:   true,  // reject dead-end / mid-clause sentences
    attempts:        32,    // generation retries before fallback
    toneBoost:       1.7,
    lexBoost:        1.0,
    // Act-conditioned start selection.  When Markov.initAct() has loaded
    // the per-act metadata, the runtime picks the next dialogue act from
    // the act_trans matrix and samples starts from the matching
    // (act, tone) pool.  actChance is the probability of using the act
    // pool vs falling back to the tone-only or global pool.
    // actBoost multiplies mid-chain continuations in the act lexicon
    // (analogous to toneBoost; 1.0 = off, 1.4 = noticeable).
    actChance:       0.70,
    actBoost:        1.4,
  };
  const SMALLTALK_RERANK_CANDIDATES = 6;
  const recentOpens = new Set();
  const recentOpensQ = [];
  const recentTexts = new Set();
  const recentTextsQ = [];
  const recentFamilies = new Map();
  const recentFamiliesQ = [];
  function rememberLine(text) {
    if (!text) return;
    recentTexts.add(text);
    recentTextsQ.push(text);
    while (recentTextsQ.length > RECENT_TEXT_KEEP) {
      recentTexts.delete(recentTextsQ.shift());
    }
    const parts = text.split(/\s+/);
    if (parts.length >= 2) {
      const key = (parts[0] + " " + parts[1]).toLowerCase().replace(/[.,!?;]/g, "");
      recentOpens.add(key);
      recentOpensQ.push(key);
      while (recentOpensQ.length > RECENT_OPEN_KEEP) {
        recentOpens.delete(recentOpensQ.shift());
      }
    }
    const family = openerFamily(text);
    if (family) {
      recentFamilies.set(family, (recentFamilies.get(family) || 0) + 1);
      recentFamiliesQ.push(family);
      while (recentFamiliesQ.length > RECENT_OPEN_KEEP) {
        const old = recentFamiliesQ.shift();
        const left = (recentFamilies.get(old) || 0) - 1;
        if (left <= 0) recentFamilies.delete(old);
        else recentFamilies.set(old, left);
      }
    }
  }

  function openerKey(text) {
    const parts = (text || "").split(/\s+/);
    if (!parts.length || !parts[0]) return "";
    const first = parts[0];
    const second = parts.length >= 2 ? " " + parts[1] : "";
    return (first + second).toLowerCase().replace(/[.,!?;]/g, "");
  }

  function firstWordLower(text) {
    const m = (text || "").match(/^[A-Za-z']+/);
    return m ? m[0].toLowerCase() : "";
  }

  function wordTokens(text) {
    return ((text || "").toLowerCase().match(/[a-z']+/g)) || [];
  }

  const WEAK_TAIL_BASE = new Set([
    "it all", "for me", "to me", "of it", "you know",
  ]);
  const WEAK_TAIL_EXTRA = new Set([
    "i guess", "i mean", "kind of", "sort of",
    "or something", "and stuff", "at all", "for sure",
  ]);

  function weakTailKind(text, strong) {
    const toks = wordTokens(text);
    if (toks.length < 2) return null;
    const tail2 = toks[toks.length - 2] + " " + toks[toks.length - 1];
    if (WEAK_TAIL_BASE.has(tail2)) return "base";
    if (strong && WEAK_TAIL_EXTRA.has(tail2)) return "filler";
    if (strong && toks.length >= 3) {
      const tail3 = toks[toks.length - 3] + " " + tail2;
      if (tail3 === "you know that" || tail3 === "i guess so"
          || tail3 === "or something else" || tail3 === "and all that") {
        return "filler3";
      }
    }
    return null;
  }

  function countStopHits(toks) {
    let hits = 0;
    for (let i = 0; i < toks.length; i++) if (STOP.has(toks[i])) hits++;
    return hits;
  }

  function isWeakLine(text) {
    const toks = wordTokens(text);
    if (!toks.length) return true;
    const cwords = contentWords(text);
    if (!cwords.length) return true;
    if (cwords.length === 1 && toks.length <= 5) return true;
    const stopHits = countStopHits(toks);
    if (toks.length >= 4 && stopHits / toks.length >= 0.75) return true;
    if (weakTailKind(text, false)) return true;
    return false;
  }

  function scoreSmalltalkCandidate(text, speaker, prevLine, anchorState, lineTone) {
    const toks = wordTokens(text);
    const curWords = contentWords(text);
    const curSet = new Set(curWords);
    const first = firstWordLower(text);
    let score = toks.length * 0.04;
    if (toks.length <= 3) score -= 1.4;
    if (isWeakLine(text)) score -= 2.2;
    else score += 0.4;
    if (toks.length >= 6 && toks.length <= 11) score += 0.25;
    else if (toks.length >= 13) score -= 0.15;
    if (weakTailKind(text, true)) score -= 1.1;
    if (toks.length >= 5 && countStopHits(toks) / toks.length >= 0.67) score -= 0.55;
    if (toks.length >= 6 && (new Set(toks)).size <= 3) score -= 0.8;
    if (prevLine) {
      const prevSet = new Set(contentWords(prevLine));
      let overlap = 0;
      prevSet.forEach((w) => { if (curSet.has(w)) overlap++; });
      score += Math.min(2, overlap) * 0.9;
      const beatPool = beatOpenersFor(prevLine);
      if (beatPool && beatPool.indexOf(first) !== -1) score += 1.1;
      const actPool = actReplyOpenersFor(prevLine);
      if (actPool && actPool.indexOf(first) !== -1) score += 0.85;
      if (prevSet.size && curSet.size && !overlap) score -= 0.35;
      if (/\?\s*$/.test(prevLine) && ANSWER_OPENERS.indexOf(first) !== -1) {
        score += 1.1;
      }
      if (/\?\s*$/.test(prevLine) && /\?\s*$/.test(text)) {
        score -= ANSWER_OPENERS.indexOf(first) !== -1 ? 0.30 : 0.85;
      }
    }
    if (anchorState && anchorState.list && anchorState.list.length && curWords.length) {
      let anchorHits = 0;
      for (let i = 0; i < curWords.length; i++) {
        if (anchorState.set.has(curWords[i])) anchorHits++;
      }
      score += Math.min(2, anchorHits) * 0.5;
    }
    const voice = VOICE_BY_NAME[speaker && speaker.name] || [];
    for (let i = 0; i < voice.length; i++) {
      if (toks.indexOf(voice[i]) !== -1) {
        score += 0.45;
        break;
      }
    }
    const toneLex = TONE_DETECT[lineTone];
    if (toneLex) {
      for (let i = 0; i < toks.length; i++) {
        if (toneLex.has(toks[i])) {
          score += 0.35;
          break;
        }
      }
    }
    if (speaker && recentFamilies.get(openerFamily(text)) >= 4) score -= 0.25;
    if (recentTexts.has(text)) score -= 1.0;
    if (recentOpens.has(openerKey(text))) score -= 0.6;
    return score;
  }

  function generateSmalltalkCandidate(speaker, prevLine, lineTone, anchorState, recipe, lineAct) {
    recipe = recipe || {};
    const seeds = seedsForSmalltalk(speaker, prevLine, lineTone, anchorState, recipe);
    const candidatePrefix = chooseVoicePrefix(speaker, recipe.prefixPolicy || "default");
    const bodyMax = candidatePrefix ? 11 : 14;
    const bodyMin = candidatePrefix ? 6 : 5;
    const body = Markov.generate({
      minWords: bodyMin,
      maxWords: bodyMax,
      topic: seeds,
      temperature: recipe.temperature != null ? recipe.temperature : 0.7,
      avoidStarts: recentOpens,
      avoidTexts: recentTexts,
      tone: lineTone,
      toneChance: MARKOV_DEFAULTS.toneChance,
      toneBoost: MARKOV_DEFAULTS.toneBoost,
      lex: lexFor(speaker),
      lexBoost: MARKOV_DEFAULTS.lexBoost,
      startFlatten: MARKOV_DEFAULTS.startFlatten,
      endBiasWindow: MARKOV_DEFAULTS.endBiasWindow,
      endBiasStrength: MARKOV_DEFAULTS.endBiasStrength,
      qualityFilter: MARKOV_DEFAULTS.qualityFilter,
      attempts: MARKOV_DEFAULTS.attempts,
      act: lineAct || null,
      actChance: MARKOV_DEFAULTS.actChance,
      actBoost: MARKOV_DEFAULTS.actBoost,
    });
    const prefix = candidatePrefix;
    const text = prefix ? prefix + " " + body : body;
    const baseScore = scoreSmalltalkCandidate(text, speaker, prevLine, anchorState, lineTone);
    return { text, score: baseScore, baseScore, replyScore: 0, act: lineAct || null };
  }

  // Build the seed pool for one smalltalk turn.  Distinctive
  // characters (high VOICE_STRENGTH) draw a voice-only pool with
  // probability ~strength so the alien sounds like an alien and not
  // like a generic NPC; everyone else blends voice + scene tone.  If
  // we have a previous line, we lift CONTINUITY_PICKS content words
  // from it and push each one in CONTINUITY_REPEAT times at the front
  // of the pool — the heavier-than-equal weighting is what actually
  // moves the topic-overlap metric (single-copy continuity got drowned
  // out by the 12-30 voice/tone seeds around it).
  function seedsForSmalltalk(speaker, prevLine, tone, anchorState, recipe) {
    recipe = recipe || {};
    const baseVoice = voiceSeeds(speaker);
    const strength = VOICE_STRENGTH[speaker && speaker.name] || 0.3;
    let seeds;
    if (recipe.voiceMode === "voice" && baseVoice.length) {
      seeds = baseVoice.slice();
    } else if (recipe.voiceMode === "blend") {
      seeds = toneSeeds(tone).concat(baseVoice);
    } else if (baseVoice.length && Math.random() < strength) {
      seeds = baseVoice.slice();
    } else {
      seeds = toneSeeds(tone).concat(baseVoice);
    }
    if (recipe.toneFrontPicks) {
      seeds = seedFront(
        toneSeeds(tone),
        Math.min(recipe.toneFrontPicks, toneSeeds(tone).length),
        recipe.toneFrontRepeat || 2
      ).concat(seeds);
    }
    if (anchorState && anchorState.list && anchorState.list.length) {
      seeds = seedFront(
        anchorState.list,
        Math.min(ANCHOR_PICKS, anchorState.list.length),
        ANCHOR_REPEAT
      ).concat(seeds);
    }
    if (prevLine) {
      const cw = contentWords(prevLine);
      if (cw.length) {
        const picks = Math.min(CONTINUITY_PICKS, cw.length);
        const front = [];
        for (let i = 0; i < picks; i++) {
          const w = cw[Math.floor(Math.random() * cw.length)];
          for (let r = 0; r < CONTINUITY_REPEAT + (recipe.continuityBonusRepeat || 0); r++) {
            front.push(w);
          }
        }
        seeds = front.concat(seeds);
      }
    }
    if (prevLine && /\?\s*$/.test(prevLine)) {
      seeds = seedFront(
        ANSWER_OPENERS,
        2,
        ANSWER_OPENERS_REPEAT + (recipe.answerBonusRepeat || 0)
      ).concat(seeds);
    }
    if (prevLine) {
      const actPool = actReplyOpenersFor(prevLine);
      if (actPool && actPool.length) {
        seeds = seedFront(actPool, 2, BEAT_OPENERS_REPEAT).concat(seeds);
      }
      const beatPool = beatOpenersFor(prevLine);
      const beat = classifyPrevBeat(prevLine);
      if (beatPool && beat && beat !== "question" && beat !== "statement") {
        seeds = seedFront(beatPool, 2, BEAT_OPENERS_REPEAT).concat(seeds);
      }
    }
    return seeds;
  }

  // Optionally prepend a short, canned signature prefix for very
  // distinctive characters.  Returns null when the speaker has no
  // bank or the random roll missed.  When we DO emit a prefix we
  // ask Markov for a slightly shorter body so the bubble doesn't
  // blow past the readable cap (≈ 60 chars).
  // Smalltalk: voice-aware seeds + topic continuity from `prevLine`,
  // optionally a voice prefix on the front, then a Markov body asked
  // for at the production tunings (tone-tagged starts, flattened
  // weights, end-bias on terminators, quality filter on tails).
  // `tone` is the encounter-level tone chosen once in buildScript; we
  // fall back to the live scene tone when called without one (e.g.
  // a one-off line outside of a full convo).
  function sampleReplyScore(speaker, prevLine, lineTone, anchorState) {
    return generateSmalltalkCandidate(
      speaker,
      prevLine,
      lineTone,
      anchorState,
      { prefixPolicy: "off" }
    ).baseScore;
  }

  function applyLookahead(candidates, replySpeaker, lineTone, anchorState) {
    if (!replySpeaker || !candidates || !candidates.length || SMALLTALK_LOOKAHEAD_TOPK <= 0) {
      return;
    }
    const ranked = candidates.slice().sort((a, b) => b.baseScore - a.baseScore);
    const subset = ranked.slice(0, Math.min(SMALLTALK_LOOKAHEAD_TOPK, ranked.length));
    for (let i = 0; i < subset.length; i++) {
      const cand = subset[i];
      cand.replyScore = sampleReplyScore(replySpeaker, cand.text, lineTone, anchorState);
      cand.score = cand.baseScore + SMALLTALK_LOOKAHEAD_WEIGHT * cand.replyScore;
    }
  }

  function makeSmalltalk(speaker, prevLine, tone, anchorState, replySpeaker, prevAct) {
    const lineTone = tone || currentTone();
    // Choose the dialogue act for this turn using the act_trans matrix.
    // The act steers start-pool selection and mid-chain actBoost in
    // Markov.generate.  We also push it up as the return value so the
    // caller can chain prevAct → nextAct across turns.
    const lineAct = (Markov.chooseAct && prevAct != null)
      ? Markov.chooseAct(prevAct)
      : null;
    const recipes = candidateRecipes(prevLine);
    const candidates = [];
    for (let i = 0; i < SMALLTALK_RERANK_CANDIDATES; i++) {
      candidates.push(generateSmalltalkCandidate(
        speaker,
        prevLine,
        lineTone,
        anchorState,
        recipes[i] || {},
        lineAct
      ));
    }
    applyLookahead(candidates, replySpeaker, lineTone, anchorState);
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      if (!best || candidates[i].score > best.score) best = candidates[i];
    }
    const text = best ? best.text : "Well, anyway.";
    const chosenAct = (best && best.act) || lineAct;
    rememberLine(text);
    updateAnchors(anchorState, text);
    return { text, act: chosenAct };
  }

  // Greeting / farewell are Markov-first, canned-fallback: ask for a
  // short sentence seeded with the appropriate opener pool; if the
  // chain can't produce something fresh and clean we drop back to
  // the hand-written banks so the convo never stalls.
  function looksLikeOpener(text, openers) {
    if (!text) return false;
    const m = text.match(/^[A-Za-z']+/);
    if (!m) return false;
    const first = m[0].toLowerCase();
    return openers.indexOf(first) !== -1;
  }
  function scoreOpenerCandidate(text, openerWords) {
    let score = 0;
    if (looksLikeOpener(text, openerWords)) score += 1.2;
    if (text && text.length <= 60) score += 0.35;
    if (isWeakLine(text)) score -= 1.0;
    if (recentTexts.has(text)) score -= 0.7;
    if (recentOpens.has(openerKey(text))) score -= 0.4;
    return score;
  }
  function makeMarkovOpener(seedPool, fallbackBank, openerWords) {
    if (!Markov.isReady || !Markov.isReady()) return pick(fallbackBank);
    let best = null;
    for (let attempt = 0; attempt < OPENER_RERANK_CANDIDATES; attempt++) {
      const text = Markov.generate({
        minWords: 3,
        maxWords: 9,
        topic: seedPool,
        temperature: 0.6,
        avoidStarts: recentOpens,
        avoidTexts: recentTexts,
        // Greetings/farewells are framing — we deliberately DON'T
        // tone-condition them (a "Hey there!" reads fine even when
        // the scene just turned tense).
        tone: null,
        toneChance: 0,
        startFlatten: MARKOV_DEFAULTS.startFlatten,
        endBiasWindow: MARKOV_DEFAULTS.endBiasWindow,
        endBiasStrength: MARKOV_DEFAULTS.endBiasStrength,
        qualityFilter: MARKOV_DEFAULTS.qualityFilter,
        attempts: MARKOV_DEFAULTS.attempts,
      });
      if (!text || text.length > 60) continue;
      const cand = { text, score: scoreOpenerCandidate(text, openerWords) };
      if (!best || cand.score > best.score) best = cand;
    }
    if (best && looksLikeOpener(best.text, openerWords)) {
      rememberLine(best.text);
      return best.text;
    }
    const fb = pick(fallbackBank);
    rememberLine(fb);
    return fb;
  }
  function makeGreeting() {
    return makeMarkovOpener(GREETING_OPENERS, GREETINGS_A.concat(GREETINGS_B), GREETING_OPENERS);
  }
  function makeFarewell() {
    return makeMarkovOpener(FAREWELL_OPENERS, FAREWELLS_A.concat(FAREWELLS_B), FAREWELL_OPENERS);
  }

  function buildScript(charA, charB) {
    // Vary cadence: most convos run 2–3 small-talk turns, a few
    // shorter, a few longer.  The extra randomness keeps two
    // overlapping conversations from looking like the same dance.
    const r = Math.random();
    let smallCount;
    if (r < 0.15) smallCount = 1;
    else if (r < 0.65) smallCount = 2;
    else if (r < 0.92) smallCount = 3;
    else smallCount = 4;
    // Encounter-level tone: pick once per chat, hold it for every
    // small-talk turn.  Querying currentTone() per line meant a quiet
    // calm chat could randomly drift into shaken vocabulary on turn 3
    // for no in-world reason; pinning the tone at the top makes the
    // back-and-forth feel coherent.
    const encounterTone = pickEncounterTone(charA, charB);
    const script = [
      { speaker: "A", text: makeGreeting() },
      { speaker: "B", text: makeGreeting() },
    ];
    const anchorState = makeAnchorState();
    let who = "A";
    let prev = script[script.length - 1].text;
    // Start with "greet" act — the opening exchange was a greeting, so
    // the first smalltalk turn should follow the greet→{chatter,ask,...}
    // transition distribution.
    let prevAct = "greet";
    for (let i = 0; i < smallCount; i++) {
      const speaker = who === "A" ? charA : charB;
      const replySpeaker = who === "A" ? charB : charA;
      const result = makeSmalltalk(speaker, prev, encounterTone, anchorState,
                                   replySpeaker, prevAct);
      // makeSmalltalk now returns {text, act}; unwrap for backward compat.
      const line = (result && result.text != null) ? result.text : result;
      prevAct = (result && result.act) || prevAct;
      script.push({ speaker: who, text: line });
      prev = line;
      who = who === "A" ? "B" : "A";
    }
    script.push({ speaker: "A", text: makeFarewell() });
    script.push({ speaker: "B", text: makeFarewell() });
    return script;
  }

  // Curated proposal/response/refusal lines for each kind of social
  // deal.  We intentionally hand-write these instead of asking Markov
  // for them: a proposal needs to read as an actual offer ("Here,
  // take my spare bottle.") not as a statistically plausible movie
  // line, and the matching yes/no needs to read as a reply to that
  // specific offer.  Per-role variants pick the alien's clinical
  // voice over the knight's formal one, so a robot offering an
  // ambush pact still sounds like a robot.  Markov is back in the
  // driver's seat for greetings and the optional middle small-talk
  // turn, so the deal scripts blend in instead of looking like a
  // pop-up dialog box stamped on top of the chat system.
  const PROPOSAL = {
    sharePotion: {
      offerByRole: {
        fighter: ["Here, take my spare bottle.", "I've got two — one's yours.",
                  "Catch — you'll need it more than I will.",
                  "On the belt: spare revive. It's yours.",
                  "Stocked up; this one's for you."],
        healer:  ["Here, dear — keep this with you.",
                  "Take my spare; it'll do you more good.",
                  "Tuck this on your belt, won't you?"],
        alien:   ["Reagent surplus detected. Transferring vial.",
                  "Allocating spare unit. Receive."],
        default: ["Take my spare bottle.", "Yours — I've got another."],
      },
      yesByRole: {
        fighter: ["Cheers — owe you one!", "Bless you, friend.",
                  "Right — bottoms-up if it comes to it!",
                  "Lifesaver. Thanks.", "Aye — take care of yours too."],
        healer:  ["Oh, thank you — bless you.",
                  "How kind. I'll keep it close.",
                  "You're a dear, truly."],
        alien:   ["Acknowledged. Vial received.",
                  "Affirmative. Storage confirmed."],
        default: ["Cheers, friend!", "Thanks — I owe you."],
      },
      noByRole: {
        fighter: ["Save it — I'm holding.", "Keep it, I'll manage.",
                  "Pass — give it to someone hurt."],
        healer:  ["Bless you, but no — keep it close.",
                  "Save it for one who'll need it more."],
        alien:   ["Negative. Stock is sufficient.",
                  "Decline. Reserves nominal."],
        default: ["Keep it — I'm fine.", "Save it for another."],
      },
    },
    moralePact: {
      offerByRole: {
        fighter: ["Stand with me when they come?",
                  "Shoulder to shoulder this round?",
                  "Got my back if it gets ugly?",
                  "Watch each other today, eh?"],
        healer:  ["Stay close to me, would you?",
                  "Mind each other today, hm?",
                  "Heads up together — yes?"],
        alien:   ["Propose mutual coverage. Affirm?",
                  "Synchronise defensive posture. Confirm?"],
        default: ["Stand with me?", "Got my back today?"],
      },
      yesByRole: {
        fighter: ["Aye — together.", "On your six.", "Side by side.",
                  "Right with you.", "Done — together it is."],
        healer:  ["Of course, dear.", "Yes — stay close.",
                  "Together it is."],
        alien:   ["Affirmative. Coverage engaged.",
                  "Acknowledged. Pair-bond active."],
        default: ["Together.", "On me."],
      },
      noByRole: {
        fighter: ["I move better alone.", "Maybe next round.",
                  "I'll fight my own corner."],
        healer:  ["I'll mind myself, dear.", "Some other time."],
        alien:   ["Negative. Solo protocol preferred.",
                  "Decline. Pair-bond inefficient."],
        default: ["Not today.", "Some other time."],
      },
    },
    restRound: {
      offerByRole: {
        fighter: ["Five minutes by the fire?",
                  "Warm up with me — quick break?",
                  "Come — we've earned a sit-down."],
        healer:  ["Come and warm up a moment?",
                  "By the fire with me, dear?"],
        alien:   ["Recommend recharge cycle. Join?",
                  "Thermal rest interval. Accompany?"],
        default: ["By the fire — quick rest?", "Sit a beat with me?"],
      },
      yesByRole: {
        fighter: ["Best idea today.", "Aye — feet ache anyway.",
                  "Lead the way.", "Right behind you."],
        healer:  ["Lovely — let's.", "Of course, dear.",
                  "Mm, yes please."],
        alien:   ["Affirmative. Routing to thermal source.",
                  "Acknowledged. Recharge accepted."],
        default: ["Lead the way.", "Aye, let's."],
      },
      noByRole: {
        fighter: ["Can't — work waiting.", "Maybe after this round.",
                  "Some other time."],
        healer:  ["Bless you, but later.", "Soon, dear — not yet."],
        alien:   ["Negative. Task queue full.",
                  "Decline. Operations pending."],
        default: ["Later.", "Not just now."],
      },
    },
    swapShift: {
      offerByRole: {
        fighter: ["Trade posts for a round?",
                  "You take mine, I'll take yours.",
                  "Want a turn at my station?"],
        healer:  ["Mind a swap, dear?",
                  "I'll cover your spot — yours mine?"],
        alien:   ["Propose station exchange. Confirm?",
                  "Workstation rotation requested."],
        default: ["Trade posts a round?", "Swap stations?"],
      },
      yesByRole: {
        fighter: ["Deal.", "Aye, why not.", "Done.", "Right then — swap."],
        healer:  ["Of course, dear.", "Lovely — let's."],
        alien:   ["Affirmative. Exchange accepted.",
                  "Acknowledged. Routing."],
        default: ["Deal.", "Aye, let's."],
      },
      noByRole: {
        fighter: ["Not today.", "I'll stay put.", "Mine's mine."],
        healer:  ["I'll keep my spot, dear.", "Another time."],
        alien:   ["Negative. Station optimal.",
                  "Decline. Reassignment refused."],
        default: ["I'll stay put.", "Some other time."],
      },
    },
    ambushPact: {
      offerByRole: {
        fighter: ["When they come — together?",
                  "Cover me, I'll cover you.",
                  "Pact: next wave, you and me?",
                  "Sworn — back to back next fight?"],
        healer:  ["Promise me you'll stay close?",
                  "Together when they come, yes?"],
        alien:   ["Propose tactical pair-bond. Confirm?",
                  "Coupled engagement requested."],
        default: ["Pact — next wave, together?",
                  "Back to back when they come?"],
      },
      yesByRole: {
        fighter: ["Sworn.", "Aye — back to back.",
                  "On me.", "Pact made.", "Side by side, then."],
        healer:  ["Promise.", "Yes — stay close.",
                  "Together, dear."],
        alien:   ["Affirmative. Pair-bond engaged.",
                  "Acknowledged. Coupling armed."],
        default: ["Sworn.", "Pact made."],
      },
      noByRole: {
        fighter: ["I work alone.", "Scatter is safer.",
                  "Not this round."],
        healer:  ["I'll do as I must, dear.", "No promises today."],
        alien:   ["Negative. Solo engagement preferred.",
                  "Decline. Coupling unnecessary."],
        default: ["I work alone.", "Not this round."],
      },
    },
    gossip: {
      offerByRole: {
        fighter: ["Heard something moved beyond the trees.",
                  "Strange tracks by the path this morning.",
                  "Saw something. Won't say what.",
                  "There's word of trouble out east."],
        healer:  ["I heard the oddest thing this morning.",
                  "There are rumours from the village…"],
        alien:   ["Anomalous signal logged due-east.",
                  "Sensor returns: unidentified movement."],
        default: ["Heard a strange one earlier.",
                  "Word is, something's stirring."],
      },
      yesByRole: {
        fighter: ["Aye — I felt it too.", "I'd best stay sharp.",
                  "Didn't like the look either.",
                  "Eyes open, then."],
        healer:  ["Oh dear — let's stay close.",
                  "I shall light extra candles tonight."],
        alien:   ["Cross-referencing. Threat plausible.",
                  "Logged. Vigilance increased."],
        default: ["Eyes open, then.", "Best stay sharp."],
      },
      // gossip is always "accepted" (Dialog.note fires on accept) so
      // a refusal pool is provided only for completeness.
      noByRole: {
        default: ["Hm. Probably nothing.", "Old wives' talk."],
      },
    },
  };

  function pickByRole(bank, c) {
    const role = (c && c.role) || "fighter";
    const pool = (bank && (bank[role] || bank.default)) || [];
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Build the line list for a deal-bearing chat.  Same shape as
  // `buildScript` (greeting → middle → farewell) so the dialog loop
  // and bubble layout don't need to know it's a deal — the only
  // difference is two of the middle lines are curated proposal /
  // response strings instead of Markov-generated small talk, with
  // an optional Markov "middle" turn between them when the deal is
  // accepted (a small "we agree, now what" beat that keeps the
  // exchange feeling like a real chat).
  function buildDealScript(charA, charB, kind, accepted) {
    const proposal = PROPOSAL[kind];
    const offerLine = pickByRole(proposal.offerByRole, charA) || "Got a moment?";
    const responseLine = accepted
      ? (pickByRole(proposal.yesByRole, charB) || "Sure.")
      : (pickByRole(proposal.noByRole,  charB) || "Not today.");
    const encounterTone = pickEncounterTone(charA, charB);
    // Optional one-turn Markov "filler" between the offer and the
    // farewell when the deal lands.  Coin-flip to keep half the
    // accepted deals nice and tight (just offer/yes/bye), and the
    // other half a beat longer so the lawn doesn't read as four
    // identical 4-bubble exchanges in a row.
    const includeMiddle = accepted && Math.random() < 0.5;
    const script = [
      { speaker: "A", text: makeGreeting() },
      { speaker: "B", text: makeGreeting() },
      { speaker: "A", text: offerLine, beat: "offer" },
      { speaker: "B", text: responseLine, beat: accepted ? "accept" : "refuse" },
    ];
    const anchorState = makeAnchorState();
    updateAnchors(anchorState, offerLine);
    updateAnchors(anchorState, responseLine);
    if (includeMiddle) {
      const middleAct = accepted ? "agree" : "chatter";
      const middleResult = makeSmalltalk(charA, responseLine, encounterTone,
                                         anchorState, charB, middleAct);
      const middleText = (middleResult && middleResult.text != null)
        ? middleResult.text : middleResult;
      script.push({ speaker: "A", text: middleText });
    }
    script.push({ speaker: "A", text: makeFarewell() });
    script.push({ speaker: "B", text: makeFarewell() });
    return script;
  }

  // Run a deal-bearing chat.  Identical bookkeeping to `begin` —
  // the convo is registered for cancellation, both partners get the
  // activeConvo handle, the loop reflows bubbles each beat — but we
  // also watch the per-line "beat" tags so we can fire the deal
  // callbacks at the moment the handshake actually happens.  If the
  // chat is cancelled (e.g. a monster turns up mid-sentence) the
  // accept callback never fires; the refuse callback fires only if
  // the offer was at least delivered before the cancel, mirroring
  // the "actually said no out loud" beat.
  async function beginDeal(charA, charB, kind, accepted, callbacks) {
    const convo = { charA, charB, cancelled: false };
    charA.activeConvo = convo;
    charB.activeConvo = convo;
    active.add(convo);
    const script = buildDealScript(charA, charB, kind, accepted);

    let landedOffer = false;
    let landedResponse = false;
    for (const line of script) {
      if (convo.cancelled) break;
      const speaker = line.speaker === "A" ? charA : charB;
      await showBubble(speaker, line.text, convo);
      if (line.beat === "offer")  landedOffer = true;
      if (line.beat === "accept" || line.beat === "refuse") landedResponse = true;
      if (convo.cancelled) break;
      await sleep(BETWEEN_LINES_MS);
    }
    active.delete(convo);
    charA.activeConvo = null;
    charB.activeConvo = null;
    Characters.endTalking(charA);
    // Fire callbacks AFTER endTalking so any state changes the
    // accept callback wants to make (warmErrand for restRound,
    // setTarget for swapShift) override the wander-away targets
    // endTalking just stamped onto both heroes.  The cancellation
    // path fires neither — the deal was never sealed.
    if (!convo.cancelled) {
      if (accepted && landedResponse && callbacks && callbacks.onAccept) {
        try { callbacks.onAccept(); } catch (e) { console.warn("onAccept failed", e); }
      } else if (!accepted && landedResponse && callbacks && callbacks.onRefuse) {
        try { callbacks.onRefuse(); } catch (e) { console.warn("onRefuse failed", e); }
      } else if (landedOffer && !landedResponse && callbacks && callbacks.onRefuse) {
        // Offer was made but the chat ended before the response —
        // count as a soft refuse so affinity still moves a touch.
        try { callbacks.onRefuse(); } catch (e) { console.warn("onRefuse failed", e); }
      }
    }
  }

  // Curated round-robin script for the campfire council.  Three
  // beats: a call to order, a volunteer bid, an acknowledgement.
  // The election callback fires AFTER the volunteer line so the
  // "lookout" sash visually appears on the elected hero just as
  // they speak — a tiny but visible cause/effect link.
  const COUNCIL_OPENERS = [
    "Right — gather round. Who stands lookout?",
    "Quick word. Need a pair of sharp eyes.",
    "Ten minutes. Who's watching the trees?",
    "Council: lookout shift. Volunteers?",
    "Listen — we need eyes up. Who's it?",
  ];
  const COUNCIL_VOLUNTEERS_BY_ROLE = {
    fighter: ["I'll take it.", "On me — I'll watch.",
              "I'll stand watch.", "Got it — eyes east.",
              "Mine. I'll keep watch.", "I'll do it. Sharp eyes here."],
    healer:  ["I can stand watch a while.",
              "I'll mind the trees, dear.",
              "Let me keep an eye out."],
    alien:   ["Affirmative. Sensor sweep accepted.",
              "Logging perimeter watch."],
    default: ["I'll take it.", "On me."],
  };
  const COUNCIL_ACKNOWLEDGE = [
    "Settled. Eyes up, then.",
    "Right — back to it, all.",
    "Done. Watch close.",
    "Good. Carry on.",
    "Agreed. Stay sharp.",
  ];

  function buildCouncilScript(attendees) {
    // Speaker indices into `attendees`.  Idx 0 opens, idx 1 (the
    // closest second hero) volunteers, idx 0 closes.  If a third
    // attendee is present we let them slip in an acknowledgement
    // before the closer, so the trio reads as actually a trio
    // instead of a duet with a silent witness.
    const opener   = COUNCIL_OPENERS[Math.floor(Math.random() * COUNCIL_OPENERS.length)];
    const volBank  = COUNCIL_VOLUNTEERS_BY_ROLE;
    const closer   = COUNCIL_ACKNOWLEDGE[Math.floor(Math.random() * COUNCIL_ACKNOWLEDGE.length)];
    const script = [{ idx: 0, text: opener, beat: "open" }];
    script.push({ idx: 1, text: pickByRole(volBank, attendees[1]) || "I'll take it.",
                  beat: "volunteer" });
    if (attendees[2]) {
      const ack3 = pickByRole(volBank, attendees[2]) || "Agreed.";
      script.push({ idx: 2, text: ack3, beat: "second" });
    }
    script.push({ idx: 0, text: closer, beat: "close" });
    return script;
  }

  async function beginCouncil(attendees, callbacks) {
    if (!attendees || attendees.length < 2) return;
    const convo = { attendees, cancelled: false };
    for (const c of attendees) c.activeConvo = convo;
    active.add(convo);
    const script = buildCouncilScript(attendees);
    for (const line of script) {
      if (convo.cancelled) break;
      const speaker = attendees[line.idx];
      if (!speaker || speaker.hp <= 0) { convo.cancelled = true; break; }
      await showBubble(speaker, line.text, convo);
      // Election fires the moment the volunteer finishes speaking
      // so the lookout aura lights up on their sprite while their
      // bubble is still on screen.  We deliberately DON'T return
      // attendees to "wandering" here — the script still has the
      // closer beat (and possibly a third attendee's "second"
      // beat) to play, and freeing them mid-script would let
      // canStartConvo grab them into a fresh chat between bubbles
      // and we'd see overlapping bubbles on the same hero.  The
      // wander-reset happens once at the end of the loop via
      // onComplete instead.
      if (line.beat === "volunteer" && callbacks && callbacks.onElect) {
        try { callbacks.onElect(); } catch (e) { console.warn("onElect failed", e); }
      }
      if (convo.cancelled) break;
      await sleep(BETWEEN_LINES_MS);
    }
    active.delete(convo);
    for (const c of attendees) c.activeConvo = null;
    // Cleanup pass.  Always runs — completion AND cancellation —
    // because damage() on a hit attendee only resets the hit hero
    // and their direct partner, but a council has three attendees
    // arranged in a partner-cycle, so a witch slap mid-volunteer
    // would leave the third hero stuck in "talking" forever
    // without us looping over the whole attendee set here.  The
    // callback is responsible for any state-flip that the chat
    // didn't perform itself (release talking-state, retarget to a
    // wander point, etc.); the lookout buff stamped by onElect
    // earlier is preserved.
    if (callbacks && callbacks.onComplete) {
      try { callbacks.onComplete(convo.cancelled); } catch (e) { console.warn("onComplete failed", e); }
    }
  }

  const active = new Set();

  async function begin(charA, charB) {
    const convo = { charA, charB, cancelled: false };
    // Stash the convo on both characters so outside code (e.g. the
    // combat checks in Characters.update) can call `cancel(c)` to
    // snap the conversation shut the moment a monster shows up.
    charA.activeConvo = convo;
    charB.activeConvo = convo;
    active.add(convo);
    const script = buildScript(charA, charB);

    for (const line of script) {
      if (convo.cancelled) break;
      const speaker = line.speaker === "A" ? charA : charB;
      await showBubble(speaker, line.text, convo);
      if (convo.cancelled) break;
      await sleep(BETWEEN_LINES_MS);
    }
    active.delete(convo);
    charA.activeConvo = null;
    charB.activeConvo = null;
    Characters.endTalking(charA);
  }

  // External interrupt: flag the character's current convo as cancelled
  // and let the loop above break out on the next await.
  function cancel(c) {
    if (c && c.activeConvo) c.activeConvo.cancelled = true;
  }

  // ----- shared bubble placement ---------------------------------------
  //
  // All live bubbles (conversation lines AND one-shot reactions) share
  // a single per-frame layout pass.  The pass:
  //   1. Reads each character's screen-space anchor point.
  //   2. If two bubbles' rectangles would overlap (and they're at
  //      similar Y), pushes them apart horizontally so they sit side
  //      by side instead of stacking on top of each other.
  //   3. Re-aims each bubble's tail (the little ▼ arrow) at the
  //      original character anchor via the `--bolklets-arrow-x` CSS
  //      variable, so even when the bubble itself has slid sideways
  //      the arrow still points down at the right speaker.
  //
  // Without this step two characters standing within ~bubble-width of
  // each other would obliterate each other's lines — you'd just see
  // the topmost bubble and have no idea who else was speaking.
  const liveBubbles = [];
  let rafPending = false;
  function ensureReflowLoop() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(tickReflow);
  }
  function tickReflow() {
    rafPending = false;
    if (!liveBubbles.length) return;
    reflowBubbles();
    ensureReflowLoop();
  }
  // Register a bubble for shared layout.  `onTick` is called every
  // frame BEFORE the layout pass; if it returns truthy the bubble is
  // assumed to be in the middle of being torn down and is skipped for
  // this frame.  The returned function unregisters the bubble (callers
  // call it from their own teardown).
  function mountBubble(character, el, onTick) {
    const entry = { character, el, onTick, removed: false };
    liveBubbles.push(entry);
    ensureReflowLoop();
    // Lay out immediately so a fresh bubble doesn't flash at (0, 0)
    // for one frame before the RAF pass moves it.
    reflowBubbles();
    return () => {
      if (entry.removed) return;
      entry.removed = true;
      const i = liveBubbles.indexOf(entry);
      if (i >= 0) liveBubbles.splice(i, 1);
    };
  }

  function reflowBubbles() {
    const stage = document.getElementById("bolklets-stage");
    const canvas = document.getElementById("bolklets-scene");
    if (!stage || !canvas) return;
    const stageRect = stage.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    const { h: spriteH } = Sprites.size();

    // Collect entries with their current anchor + measured size.
    // `onTick` runs first so a bubble in the middle of being torn
    // down (e.g. a conversation line whose convo just got cancelled)
    // is skipped this frame instead of flashing in a stale spot.
    const items = [];
    for (const e of liveBubbles.slice()) {
      if (e.removed) continue;
      if (e.onTick && e.onTick()) continue;
      if (e.removed) continue;
      const c = e.character;
      if (!c) continue;
      const sx = rect.left + (c.x * scaleX);
      const sy = rect.top + ((c.y - spriteH - 4) * scaleY);
      const anchorX = sx - stageRect.left;
      const anchorY = sy - stageRect.top;
      const bw = e.el.offsetWidth || 0;
      const bh = e.el.offsetHeight || 0;
      items.push({ e, anchorX, anchorY, bw, bh, x: anchorX, y: anchorY });
    }
    if (!items.length) return;

    // Spread overlapping bubbles horizontally.  Iterative neighbour
    // push: sort by anchor X, then for each adjacent pair whose
    // vertical bands intersect AND whose horizontal rects overlap,
    // push the two centres apart symmetrically by the overlap.  A
    // few passes are enough for the small handful of live bubbles we
    // ever have on stage at once (≤ 5 characters → ≤ 5 bubbles).
    items.sort((a, b) => a.anchorX - b.anchorX);
    const GAP = 6;
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (let i = 0; i < items.length - 1; i++) {
        const a = items[i], b = items[i + 1];
        const ay1 = a.y - a.bh, ay2 = a.y;
        const by1 = b.y - b.bh, by2 = b.y;
        if (ay2 < by1 || by2 < ay1) continue;
        const aRight = a.x + a.bw / 2;
        const bLeft  = b.x - b.bw / 2;
        const overlap = aRight + GAP - bLeft;
        if (overlap <= 0) continue;
        const half = overlap / 2;
        a.x -= half;
        b.x += half;
        changed = true;
      }
      if (!changed) break;
    }

    // Clamp to stage bounds so a bubble can't get pushed off-screen
    // when a hero is hugging the edge.
    const stageWidth = stageRect.width;
    for (const it of items) {
      const half = it.bw / 2;
      if (it.x - half < 4) it.x = 4 + half;
      if (it.x + half > stageWidth - 4) it.x = stageWidth - 4 - half;
    }

    // Apply position + arrow offset.  Arrow is clamped to inside the
    // bubble (with a small inset) so even an extreme push doesn't
    // leave the tail floating outside the box.
    for (const it of items) {
      it.e.el.style.left = it.x + "px";
      it.e.el.style.top  = it.y + "px";
      let arrowDx = it.anchorX - it.x;
      const maxArrow = Math.max(0, it.bw / 2 - 8);
      if (arrowDx >  maxArrow) arrowDx =  maxArrow;
      if (arrowDx < -maxArrow) arrowDx = -maxArrow;
      it.e.el.style.setProperty("--bolklets-arrow-x", arrowDx + "px");
    }
  }

  // Short, standalone bubble above a single character — no back-and-
  // forth, no convo bookkeeping, just a floating line that follows
  // them for a beat and then fades.  Used by `curse`, `thanks`, and
  // the reactive bark system.  We DON'T stash this in
  // `character.bubble` so it can't collide with the conversation
  // bubble system: a reaction bubble is its own ephemeral DOM node.
  // Per-speaker class, e.g. `bolklets-by-robot`.  Used to give the
  // robot's bubble a stripped-down digital-readout style (see
  // `.bolklets-by-robot` in style.css); other characters get the
  // class too but no rule targets them by default — adding more
  // per-speaker styles is a CSS-only change from here on.
  function speakerClass(character) {
    if (!character || !character.name) return "";
    return "bolklets-by-" + character.name;
  }

  function oneShotBubble(character, text, durMs, extraClass) {
    if (!character) return;
    const host = document.getElementById("bolklets-bubbles");
    if (!host) return;
    const bub = document.createElement("div");
    const cls = ["bolklets-bubble", speakerClass(character)];
    if (extraClass) cls.push(extraClass);
    bub.className = cls.filter(Boolean).join(" ");
    bub.textContent = text;
    host.appendChild(bub);
    const unmount = mountBubble(character, bub, null);
    setTimeout(() => {
      unmount();
      bub.classList.add("bolklets-fade");
      setTimeout(() => bub.remove(), 200);
    }, durMs);
  }

  // Short cartoon-style swearing bubble: 3–5 random symbols from the
  // comic-strip palette that pops up for a beat above the character.
  // Used when a hero takes a hit so it reads instantly that they got
  // smacked and are not happy about it.  A per-character cooldown
  // keeps rapid-fire hits from stacking a wall of curse bubbles —
  // one swear per beat, not one per frame.
  const CURSE_GLYPHS = ["!", "@", "#", "$", "%", "&", "*", "?", "!!", "#!"];
  const CURSE_MS = 900;
  const CURSE_COOLDOWN_MS = [1800, 2800];
  function curse(character) {
    if (!character) return;
    const now = performance.now();
    if (character._curseMuteUntil && now < character._curseMuteUntil) return;
    character._curseMuteUntil = now +
      CURSE_COOLDOWN_MS[0] +
      Math.random() * (CURSE_COOLDOWN_MS[1] - CURSE_COOLDOWN_MS[0]);
    const n = 3 + Math.floor(Math.random() * 3);
    let text = "";
    for (let i = 0; i < n; i++) {
      text += CURSE_GLYPHS[Math.floor(Math.random() * CURSE_GLYPHS.length)];
    }
    oneShotBubble(character, text, CURSE_MS, "bolklets-curse");
  }

  // Gratitude bubble that pops up above a just-revived hero: a short
  // curated gratitude opener, sometimes followed by a Markov tail for
  // a little extra personality ("Thank you! I owe you a pint and a
  // proper chat, …").  The Markov tail only tags along when the model
  // is loaded AND the roll says so — the hand-written openers are
  // always the first word the player sees so the bubble still reads
  // as a "thank you" even when the small-talk continuation is weird.
  const THANKS_OPENERS = [
    "Thank you!",
    "Thanks, friend!",
    "Oh, thank you!",
    "You saved me!",
    "Phew — thanks!",
    "I owe you one!",
    "Cheers, pal!",
    "Bless you!",
    "You're the best!",
    "Thanks a bunch!",
    "I'm alive! Thank you!",
    "Oh wow — thanks!",
    "Whew, that was close — thanks!",
    "My hero!",
  ];
  const THANKS_MS = 2400;
  const THANKS_TAIL_CHANCE = 0.45;
  function buildThanksLine() {
    const opener = THANKS_OPENERS[Math.floor(Math.random() * THANKS_OPENERS.length)];
    if (Math.random() < THANKS_TAIL_CHANCE && Markov.isReady()) {
      const tail = Markov.generate({
        minWords: 3, maxWords: 8,
        temperature: 0.6,
        avoidStarts: recentOpens,
        avoidTexts: recentTexts,
        // Mild "shaken" lean — gratitude lines tend to follow a
        // hairy moment (the patient just got revived from 0 HP).
        // Even when the lex-detect doesn't fire, biasing toward
        // shaken-tagged starts keeps the tail in the right register.
        tone: "shaken",
        toneChance: MARKOV_DEFAULTS.toneChance,
        toneBoost: MARKOV_DEFAULTS.toneBoost,
        startFlatten: MARKOV_DEFAULTS.startFlatten,
        endBiasWindow: MARKOV_DEFAULTS.endBiasWindow,
        endBiasStrength: MARKOV_DEFAULTS.endBiasStrength,
        qualityFilter: MARKOV_DEFAULTS.qualityFilter,
        attempts: MARKOV_DEFAULTS.attempts,
      });
      if (tail && tail.length < 80) {
        rememberLine(tail);
        return opener + " " + tail;
      }
    }
    return opener;
  }
  function thanks(character) {
    if (!character) return;
    oneShotBubble(character, buildThanksLine(), THANKS_MS);
  }

  // "You're welcome" reply from the reviver, scheduled to appear a
  // beat after the corresponding thanks bubble so the two read as a
  // back-and-forth instead of overlapping.  Role-flavoured: the
  // healer is warm and motherly, the alien sounds like a service
  // technician, fighters shrug it off.  We skip the reply if the
  // reviver has died or wandered off-screen between the cast and the
  // delayed fire — happens occasionally in chaotic fights.
  const WELCOME_LINES = {
    fighter: ["No worries, friend!", "Don't mention it.",
              "Walk it off!", "We look out for each other.",
              "Anytime!", "You owe me a drink.",
              "Stay close to me next time.", "On your feet, soldier."],
    healer:  ["Of course, dear.", "You're safe now.",
              "Easy now.", "I'm just glad you're back.",
              "It's the least I could do.",
              "Don't scare me like that again.",
              "Take it slow for a moment."],
    alien:   ["Bzzt — sequence complete.",
              "You owe my battery.",
              "Standard procedure.",
              "Earthling restored."],
    default: ["Don't mention it.", "Anytime!"],
  };
  const WELCOME_DELAY_MS = 1100;
  const WELCOME_MS = 2200;
  function welcomeStillValid(reviver) {
    if (!reviver) return false;
    if (reviver.combatMode === "dead") return false;
    if (reviver.hp <= 0) return false;
    if (typeof Characters !== "undefined" && Characters.isVisibleNow &&
        !Characters.isVisibleNow(reviver)) return false;
    return true;
  }
  function welcome(reviver) {
    if (!welcomeStillValid(reviver)) return;
    setTimeout(() => {
      if (!welcomeStillValid(reviver)) return;
      const role = reviver.role || "fighter";
      const pool = WELCOME_LINES[role] || WELCOME_LINES.default;
      const line = pool[Math.floor(Math.random() * pool.length)];
      oneShotBubble(reviver, line, WELCOME_MS);
    }, WELCOME_DELAY_MS);
  }

  // ----- one-shot reactive "barks" -------------------------------------
  // Short, hand-written quips that fire on concrete in-game events
  // (a monster falls, somebody panics, the alien lifts off, a potion
  // gets gulped, a chest gets opened).  We deliberately DON'T route
  // these through Markov: combat-y barks are short, snappy, and need
  // to read instantly — Markov word salad would just look weird.
  //
  // Each kind has a per-role line bank (`fighter` / `healer` / `alien`
  // / `default`) so the alien sounds robotic, the healer sounds
  // softer, and the bruisers sound cocky without us writing a
  // separate dialog tree per character.
  //
  // Per-character cooldowns keep a single hero from chain-barking
  // every kill in a brawl — at most one bark per ~1.6s per hero, and
  // each kind has its own longer cooldown so you don't get two
  // "Got him!"s in a row.
  const BARKS = {
    kill: {
      fighter: ["Got him!", "One down!", "Easy.", "Eat that!", "Boom.",
                "Take that!", "Stay down.", "Next!", "Ha!", "Down you go.",
                "That'll do.", "Hah!"],
      healer:  ["Phew, off he goes.", "Bye bye!", "Yikes!",
                "Oh thank goodness."],
      alien:   ["Vaporised.", "Target neutral.", "Bzzt.",
                "Earthling defeated.", "Erased."],
      default: ["Got him!", "One down!", "Take that!"],
    },
    flee: {
      fighter: ["Falling back!", "Too hot!", "Need a moment!", "Regroup!",
                "Tactical retreat!", "I'm out!", "Whoa, nope!"],
      healer:  ["I gotta go!", "Help! Help!", "Eek!", "No no no!",
                "Can't, can't, can't!"],
      alien:   ["Withdraw!", "Power low.", "Returning to ship.",
                "Aborting mission."],
      default: ["I'm out!", "Falling back!"],
    },
    boardUfo: {
      alien:   ["Up we go!", "Lift-off!", "Beam me up!", "Eject!",
                "Cleared for takeoff.", "Bzzt — engaging."],
      default: ["Up we go!"],
    },
    landUfo: {
      alien:   ["Touchdown.", "All quiet now.", "Back on the ground.",
                "Whew.", "Mission complete."],
      default: ["Touchdown."],
    },
    chestOpen: {
      fighter: ["What's in here?", "Ooh, loot!", "A bottle, please!",
                "Aha.", "Don't mind if I do."],
      healer:  ["Let's see…", "Hello in there?", "Hmm."],
      default: ["What's in here?", "Aha."],
    },
    chestDeposit: {
      healer:  ["Fresh batch!", "There you go.", "For later, friends.",
                "Stocked.", "Drink up, boys!"],
      default: ["For later."],
    },
    drink: {
      fighter: ["Mmm.", "Aaah, better.", "Glug glug.",
                "That hits the spot.", "Refreshing!"],
      healer:  ["Ooh, lovely.", "Mmm.", "That's better."],
      default: ["Mmm."],
    },
    // Aborting a chest-drink errand because someone (the healer, the
    // campfire, a flower bloom) topped us back up before we got there.
    // Reads as a small "oh, no need then" beat so the U-turn is
    // visible instead of looking like the hero just lost interest in
    // the chest mid-stride.
    cancelDrink: {
      fighter: ["Oh — I'm fine now.", "Never mind!", "Patched already.",
                "Cheers — saved a bottle.", "All better — back to it.",
                "Don't need it.", "I'm good now."],
      healer:  ["Oh — I'm fine, thank you.", "Never mind, dear.",
                "All patched, no need.", "Saved a bottle — lovely."],
      alien:   ["Vitals restored. Withdraw.", "Bottle unnecessary.",
                "Repair complete — stand down."],
      default: ["Never mind!", "I'm fine now.", "Don't need it."],
    },
    usePotionRevive: {
      fighter: ["Drink this, friend!", "Up you go!", "Back on your feet!",
                "Don't you die on me!", "Wake up!", "Hold still — drink!"],
      healer:  ["Here, friend, drink this!", "Wake up, please!",
                "Up you come, dear."],
      alien:   ["Reanimating subject.", "Vital sequence engaged.",
                "Re-boot, earthling."],
      default: ["Up you go!", "Wake up, friend!"],
    },
    helpCall: {
      fighter: ["Help!", "HELP!", "Help! Help!",
                "Backup, please!", "I need a hand!",
                "Get over here!", "Help me out!", "Cover me!",
                "Anyone?!", "Guys?!", "On me, on me!",
                "I'm in trouble!", "Quickly!", "Aaargh — help!",
                "Hey! A little help?!"],
      healer:  ["HELP!", "Help, help, HELP!", "Somebody, please!",
                "I can't fight it!", "Eek — help!", "Get it off me!",
                "AAH! Help!", "Stop it, stop it!",
                "Please, anyone!", "I'm hurt!",
                "It's biting me!", "Save meee!"],
      alien:   ["DISTRESS!", "Mayday — mayday!", "Assistance required.",
                "Backup signal!", "Bzzt — help!", "Code red!",
                "All units!", "Shields failing — help!"],
      default: ["Help!", "HELP!", "Over here!", "I need help!"],
    },
    helpAnswer: {
      fighter: ["On my way!", "Hold on!", "Coming!",
                "Hang in there!", "I've got you!", "Almost there!",
                "I'm coming, hold on!", "Hold the line!",
                "Don't worry — I'm coming!", "Stay alive!"],
      healer:  ["I'm coming!", "Hold on, dear!", "Almost there!",
                "Don't move!", "I'm right behind you!",
                "Stay with me!"],
      alien:   ["Inbound.", "Acknowledged.", "Vector locked.",
                "Engaging.", "ETA short."],
      default: ["Coming!", "On my way!", "Hold on!"],
    },
    // Fighter peels off to defend a healer being chased by a
    // monster.  Per-role flavour: knights / vikings sound formal
    // and protective, the witch / firemage scolding, the alien
    // clinical, the robot terse.  Used by maybeEnterCombat's
    // healer-guard branch (see monsterChasingHealer).
    guardHealer: {
      fighter: ["For the priest!", "Off her, beast!",
                "Defending the healer!", "Get away from her!",
                "Don't touch her!", "I've got the medic!",
                "Hands off, scum!", "Back away from her!"],
      alien:   ["Defending support unit.", "Threat on medic.",
                "Engaging healer's pursuer."],
      default: ["Off her!", "Get back!", "Hands off!"],
    },
    // "I've got this one!" — a closer reviver shouts to the one
    // jogging in from the other side of the lawn so they can stand
    // down instead of doubling up on the same corpse.  Per-role flavour
    // keeps the witch sounding bookish, the girl warm, the alien
    // procedural.
    claimRevive: {
      fighter: ["I've got this one!", "I'll handle it!", "Stand down — mine!",
                "I've got him, friend!", "Leave it to me!", "On it!",
                "I'm closer — I'll do it!", "Step back, I've got it!",
                "Cover me — I'll cast!"],
      healer:  ["I'll take this one, dear.", "I've got him — you rest.",
                "Let me, please.", "I'm right here — go on.",
                "Easy now, I'll handle it.", "Save your breath, I've got him."],
      alien:   ["Override — I'll process.", "Closer unit assuming task.",
                "Reroute — I'll revive.", "Affirmative, I have the body.",
                "Disengage, I'll handle it."],
      default: ["I've got this!", "I'll do it!", "Mine — stand down!"],
    },
    // Counterpart to claimRevive: the hero who got preempted gives a
    // quick acknowledgement before peeling off.  Keeps the swap from
    // feeling like the original just silently teleported away.
    yieldRevive: {
      fighter: ["All yours!", "Got it — peeling off.", "Roger, you take it.",
                "Acknowledged.", "Fair enough — going hunting.", "Thanks, friend!"],
      healer:  ["Bless you, dear.", "Oh, thank you!", "All yours, friend.",
                "I'll find another."],
      alien:   ["Acknowledged. Disengaging.", "Task transferred.",
                "Affirmative — rerouting.", "Stand down complete."],
      default: ["All yours!", "Acknowledged.", "Right then — going."],
    },
    // Witch peeling off mid-deposit to press a fresh heal bottle into
    // a wounded friend's hand instead of stocking the chest.  Reads
    // as a quick, warm "this is for you" rather than the chest-side
    // "stocked" flavour of chestDeposit.
    handoffGive: {
      fighter: ["Here — drink this!", "Take it, friend!",
                "You need it more!", "Catch — drink up!",
                "Don't argue, drink!"],
      healer:  ["Here you are, dear.", "Drink this, please.",
                "For you, friend — quick.", "Take it, you need it.",
                "Easy now — drink."],
      alien:   ["Reagent transfer — drink.", "Allocating supply unit.",
                "Restoration vial, accept."],
      default: ["Here — drink this!", "Take it, friend!"],
    },
    // Recipient acknowledging the bottle just before they tip it
    // back.  Short and grateful so the exchange reads as a beat.
    handoffThanks: {
      fighter: ["Thanks!", "Cheers!", "Owe you one!",
                "Right — bottoms up!", "Bless you!", "Lifesaver!"],
      healer:  ["Oh, thank you!", "Bless you, friend.",
                "How kind — thank you.", "You're a dear."],
      alien:   ["Acknowledged. Ingesting.", "Vial received. Thanks."],
      default: ["Thanks!", "Cheers, friend!"],
    },
    // The patient acknowledging the healer's spell as it lands.
    // Uttered by whoever is BEING healed, not by the healer — so the
    // role split is over the patient's role, and we want options for
    // every archetype the girl might patch up.  Kept short so the
    // bubble doesn't crowd the holy-rain VFX.  The healer bot
    // doesn't need its own line — fighters / aliens / the witch
    // covers everyone who actually takes hits in the field.
    healThanks: {
      fighter: ["Thanks!", "Cheers!", "Better!",
                "That helps!", "Bless you!", "Patched up!",
                "Much obliged.", "Right as rain.",
                "Thank you!", "Oh — thanks!",
                "Saved me!", "Owe you one!"],
      healer:  ["Thank you, dear.", "Bless you.",
                "Oh — thank you!", "Kind of you."],
      alien:   ["Wounds repaired. Thanks.",
                "Restoration acknowledged.",
                "Acceptable. Thanks."],
      default: ["Thanks!", "Bless you!"],
    },
    // Healer's warm reply to a patient's "thanks" after a heal
    // lands.  Scheduled by characters.js a beat after the patient
    // bark fires so the two bubbles read as a back-and-forth
    // instead of stacking on the same frame.  Only the girl ever
    // casts the long-range heal that triggers this exchange, but
    // we keep a default bank for safety.
    healWelcome: {
      healer:  ["Of course, dear.", "There you are.", "All better.",
                "Easy now.", "Stay safe.", "Mind yourself.",
                "Hold still — there.", "You're welcome.",
                "Glad to help.", "Patched."],
      default: ["Anytime."],
    },
    // Firemage uncorking his "rain of fire" AoE on a clustered group
    // of monsters.  Only the firemage casts it (no role split needed
    // beyond the fighter bank); kept short and theatrical so the
    // bubble doesn't crowd the meteor shower itself.
    fireRain: {
      fighter: ["Rain of fire!", "Burn, all of you!", "Skies, fall!",
                "Eat the sky!", "Sear them!", "Fire above!",
                "Cinders!", "Embers — fall!"],
      default: ["Rain of fire!", "Burn!"],
    },
    // Healer kicking off her mount summon spell.  Short, theatrical,
    // and only fires once per cast (the bark cooldown takes care of
    // rapid re-entry into the same line).  The girl is the only role
    // that ever casts this — but we keep a default bank for safety.
    summonHorse: {
      healer:  ["Hi-yo!", "Won't be a moment!", "To horse!",
                "Coming to you!", "Bring me the bridle!"],
      default: ["Hi-yo!"],
    },
    // The little exclamation when her summoned mount touches down
    // and she swings into the saddle.
    mountUp: {
      healer:  ["Onward!", "Hyah!", "Let's ride!", "Hold on, dear!"],
      default: ["Onward!"],
    },
    // Ninja's quiet under-his-breath line as he plants the katana
    // through the soil into a buried worm.  Short, breath-y; only
    // the ninja ever fires this so we keep his bank tight and use a
    // single neutral default for safety.
    wormStab: {
      fighter: ["Hsst.", "Found you.", "Hush...",
                "Sleep.", "Got you.", "Down there?",
                "Caught you.", "Quiet now."],
      default: ["Hsst."],
    },
    // Healer's "split" cast — a panicked, mischievous shout right
    // before the clone pops in.  Healer-only by current trigger,
    // but a default is provided in case another role ever picks
    // up the spell.
    decoyCast: {
      healer:  ["Splitting!", "Catch this!", "Wrong one!",
                "Don't follow me!", "Not really here.",
                "Trick!", "Halfway gone!"],
      default: ["Trick!"],
    },
    // "Sorry, gotta dash!" — a hero breaking off a conversation
    // because something more urgent than gossip just came up
    // (wounded self, friend on the ground, an open help call, an
    // ally bleeding badly).  Lines stay short and apologetic so
    // the U-turn reads as polite rather than hostile.  The trigger
    // site (excuseFromConvo in characters.js) cancels the chat,
    // resets both partners to wandering, and schedules this bark
    // ~350 ms later so it lands AFTER the chat bubble has faded
    // off (Dialog.bark suppresses one-shots while c.bubble is set).
    excuseConvo: {
      fighter: ["Sorry — gotta go!", "Hold that thought!",
                "Later, friend!", "Gotta run!", "Excuse me!",
                "Trouble — sorry!", "Catch you after!",
                "Pardon — work to do!", "Got business!"],
      healer:  ["Sorry, dear — duty calls.", "Forgive me — quickly!",
                "Hold that thought, please.", "I must go — sorry!",
                "Duty first — sorry!", "Pardon me — needed elsewhere."],
      alien:   ["Conversation suspended.", "Pause sequence engaged.",
                "Negotiation deferred.", "Disengaging — priority task.",
                "Override — stand by."],
      default: ["Sorry — got to go!", "Excuse me!", "Later!"],
    },
  };

  // Per-bark CSS class for the one-shot bubble.  Most barks use the
  // default chat-bubble look; help calls reuse the same typography /
  // frame size but add yellow-red colours plus a continuous shake
  // (see `.bolklets-help` in style.css) so panic shouts read as
  // distress without oversized type.
  const BARK_CLASS = {
    helpCall: "bolklets-help",
  };

  // Small per-kind probabilities so we don't blast every event with a
  // bubble.  Reads natural: roughly half of takeoffs, a third of kills,
  // most drinks.  Tweak in one place if it ever feels too chatty.
  const BARK_PROB = {
    kill:         0.30,
    flee:         0.45,
    boardUfo:     0.65,
    landUfo:      0.55,
    chestOpen:    0.55,
    chestDeposit: 0.65,
    drink:        0.65,
    cancelDrink:  0.70,
    usePotionRevive: 0.85,
    // Help call: forced (`force: true`) by tryCallForHelp in
    // characters.js, so this probability only applies if some other
    // path bubbles it organically.  Set high so it always reads.
    helpCall:     1.00,
    helpAnswer:   0.85,
    // Revive hand-off: the closer hero almost always shouts so the
    // swap visibly reads on screen; the original mutters back about
    // half the time so the exchange has rhythm without being noisy.
    claimRevive:  0.95,
    yieldRevive:  0.55,
    // Hand-off detour: the witch's "drink this!" almost always reads
    // (the whole point is to make the rerouting visible); the
    // recipient's thanks fires a bit less often so the exchange has
    // rhythm without doubling up bubbles in the same beat.
    handoffGive:  0.95,
    handoffThanks: 0.55,
    // Heal-thanks: bumped high so the patient almost always
    // acknowledges a heal landing.  The per-kind cooldown (~6.5s)
    // still prevents back-to-back mumbling during a long cast
    // session, so this only really affects the FIRST heal of each
    // session — and that's the beat the player most wants to see
    // ("the healer just patched me up").  Previously this sat at
    // 0.55, which combined with the cooldown to leave many short
    // 1-2-tick heals completely silent on the patient's side.
    healThanks:   0.90,
    // Healer's reply to a successful patient thanks.  The
    // characters layer schedules this ~700 ms after a healThanks
    // bark fires so the exchange reads as a beat instead of two
    // bubbles popping at the same instant.
    healWelcome:  0.85,
    // Rain of fire: rare-ish (one per several seconds) and visually
    // huge, so we want the shout almost every cast — ties the
    // signature spell to a signature line.
    fireRain:     0.95,
    // Ninja worm-stab: stealth move, so he only mutters about a
    // third of the time — keeps the line surprising instead of
    // ruining the silent-killer vibe.
    wormStab:     0.35,
    // Healer decoy: the spell already has its own visible aura and
    // pop, so the bark is a flavour beat rather than the main cue.
    // Slightly less than half of casts feels right — too much and
    // the line loses surprise on the long cooldown.
    decoyCast:    0.55,
    // Healer-guard: a fighter peeling off to defend a healer being
    // chased.  Frequent enough that you usually hear the call, but
    // not every single peel — a 65 % bark mixed with the per-kind
    // cooldown lands roughly one shout per defence sortie.
    guardHealer:  0.65,
    // Excuse-me from a conversation: this only fires when the chat
    // is already being cancelled for a real reason (wounded self,
    // corpse on lawn, open help call, …), so we want it to read
    // almost every time — a silent break-off looked like a glitch
    // ("the witch teleported away mid-sentence").  The bark site
    // forces it via opts.force, so this probability is effectively
    // a fallback for any future caller that doesn't.
    excuseConvo:  0.95,
  };
  // Barks split into two flavours:
  //   • combat barks (`kill`, `flee`) — fine to mutter to yourself,
  //     it's a heat-of-the-moment thing and reads natural even when
  //     the hero is alone on screen.
  //   • social barks (everything else — boarding the UFO, opening a
  //     chest, drinking a potion, …) — only fire if there's another
  //     live character close enough to plausibly hear it, otherwise
  //     a hero standing alone announcing "Beam me up!" to an empty
  //     lawn just looks weird.
  const BARK_NEEDS_AUDIENCE = {
    kill:         false,
    flee:         false,
    boardUfo:     true,
    landUfo:      true,
    chestOpen:    true,
    chestDeposit: true,
    drink:        true,
    // Cancelling a drink run is a private mutter — fine without an
    // audience.  Bystanders won't always be near the chest queue
    // (they're off doing their own thing), and gating the line on
    // someone being there would just suppress most U-turns.
    cancelDrink:  false,
    // Yelling at a corpse you're about to revive is fine on its own
    // — the corpse counts as the audience even though hasAudience()
    // skips dead characters.  Don't gate this one.
    usePotionRevive: false,
    // "Help!" is always shouted regardless of audience — that's the
    // whole point, and the call itself is what the audience reacts
    // to.  The answering "On my way!" needs an audience (the caller)
    // by definition, but tryAnswerHelp only fires it when there is
    // one, so the per-bark gate doesn't add anything.
    helpCall:     false,
    helpAnswer:   false,
    // The original reviver IS the audience for "I've got this!" and
    // vice-versa, so neither needs the generic audience gate.
    claimRevive:  false,
    yieldRevive:  false,
    // The recipient is the witch's audience by definition, and vice
    // versa, so neither needs the generic audience gate.
    handoffGive:  false,
    handoffThanks: false,
    // Thanking the healer is a social bark — but the healer herself
    // is the audience by definition (she's right next to her
    // patient, mid-cast), so leaving this `false` keeps the line
    // even if no third party is around.  Setting it `true` would
    // suppress the thanks during a 1-on-1 heal, defeating the
    // purpose.
    healThanks:   false,
    // Healer's reply: same logic — patient is the audience by
    // definition, no need for a third-party bystander gate.
    healWelcome:  false,
    // Combat shout — the firemage yells it AT the monsters he's
    // about to delete, no need for a friendly bystander.
    fireRain:     false,
    // Ninja's stab is a private moment — no audience needed (the
    // worm is the audience, even if it can't bark back).
    wormStab:     false,
    // Healer's decoy shout is a panic beat — the audience is
    // whoever is chasing her, and the clone itself is the
    // "audience" by definition.  Fire regardless of bystanders.
    decoyCast:    false,
    // Healer-guard: the audience is the healer herself (and the
    // monster).  Both are right there by definition, so no need
    // for a third-party bystander gate.
    guardHealer:  false,
    // Excuse-me bark fires AFTER the chat is already cancelled
    // (and the partner has been kicked back to wandering), so the
    // partner is technically no longer a chat partner anymore —
    // but they're still standing right there for the next ~350 ms
    // and the audience check passes naturally.  We leave this
    // false so the bark still reads cleanly even if the partner
    // happens to have wandered out of audience radius by the time
    // the timer fires (e.g. they got hit and bolted).
    excuseConvo:  false,
  };
  const BARK_AUDIENCE_RADIUS_PX = 110;
  const BARK_KIND_COOLDOWN_MS = 6500;
  const BARK_ANY_COOLDOWN_MS = 2200;
  // Reading time for short barks: floor of ~1.7s so even a single
  // word like "Mmm." stays on screen long enough to register, plus
  // ~70 ms per character for longer ones.  Capped so the longest
  // line still clears the stage in a reasonable beat.
  function barkDuration(text) {
    const ms = 900 + text.length * 70;
    return Math.max(1700, Math.min(3200, ms));
  }

  function pickBarkLine(c, kind) {
    const bank = BARKS[kind];
    if (!bank) return null;
    const role = (c && c.role) || "fighter";
    const pool = bank[role] || bank.default;
    if (!pool || !pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Is there another live, on-stage character close enough to `c` to
  // plausibly hear them speak?  Used to gate social barks so heroes
  // don't announce things to an empty lawn.
  function hasAudience(c, radiusPx) {
    if (typeof Characters === "undefined" || !Characters.list) return false;
    const r2 = radiusPx * radiusPx;
    const cx = c.x, cy = c.y;
    for (const other of Characters.list) {
      if (other === c) continue;
      if (other.hp <= 0) continue;
      if (other.combatMode === "dead") continue;
      if (Characters.isVisibleNow && !Characters.isVisibleNow(other)) continue;
      const dx = other.x - cx, dy = other.y - cy;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  function bark(c, kind, opts) {
    if (!c) return false;
    if (c.hp <= 0) return false;
    if (c.combatMode === "dead") return false;
    // Don't stomp an active conversation — the small-talk bubble is
    // already saying something, an extra one-shot on top would just
    // double up and look like noise.
    if (c.bubble) return false;
    const force = !!(opts && opts.force);
    if (!force) {
      const p = BARK_PROB[kind];
      if (typeof p === "number" && Math.random() > p) return false;
      // Social barks only fire if somebody's around to hear them.
      // Combat barks bypass this — muttering "Got him!" while alone
      // still reads fine, "Beam me up!" to an empty lawn does not.
      if (BARK_NEEDS_AUDIENCE[kind] && !hasAudience(c, BARK_AUDIENCE_RADIUS_PX)) {
        return false;
      }
    }
    const t = performance.now();
    if (!c._barkState) c._barkState = { any: 0, byKind: {} };
    const state = c._barkState;
    if (t < state.any) return false;
    const kindUntil = state.byKind[kind] || 0;
    if (t < kindUntil) return false;
    const line = pickBarkLine(c, kind);
    if (!line) return false;
    state.any = t + BARK_ANY_COOLDOWN_MS;
    state.byKind[kind] = t + BARK_KIND_COOLDOWN_MS;
    oneShotBubble(c, line, barkDuration(line), BARK_CLASS[kind]);
    return true;
  }

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  function showBubble(character, text, convo) {
    return new Promise((resolve) => {
      const host = document.getElementById("bolklets-bubbles");
      const bub = document.createElement("div");
      const cls = ["bolklets-bubble", speakerClass(character)];
      bub.className = cls.filter(Boolean).join(" ");
      bub.textContent = text;
      host.appendChild(bub);
      character.bubble = bub;

      let done = false;
      let unmount = null;
      function finish() {
        if (done) return;
        done = true;
        if (unmount) unmount();
        bub.classList.add("bolklets-fade");
        setTimeout(() => {
          bub.remove();
          if (character.bubble === bub) character.bubble = null;
          resolve();
        }, 200);
      }

      // Cheap per-frame cancellation check (drives finish if convo
      // got flagged cancelled, e.g. a monster turned up mid-line).
      // Returning true from `onTick` tells the layout pass to skip
      // this bubble for the current frame; finish() then unmounts it
      // properly so it stops appearing in subsequent passes.
      unmount = mountBubble(character, bub, () => {
        if (convo && convo.cancelled) { finish(); return true; }
        return false;
      });

      const ms = estimateReadingTime(text);
      setTimeout(finish, ms);
    });
  }

  return { begin, beginDeal, beginCouncil, cancel, curse, thanks, welcome, bark, note };
})();
