# bolklets

`bolklets` is a drop-in pixel strip for web pages: ten characters walk
between activity stations, meet each other, and chat in English using a
locally trained Markov dialogue model.

<img width="1000" height="229" alt="" src="https://github.com/user-attachments/assets/7757cc4a-6dc5-42e2-a10e-14361469c2ce" />

## TL;DR

- Build: `make all`
- Run demo: `make serve` then open `http://localhost:8765/dist/index.html`
- Embed elsewhere: host `dist/bolklets.js` + `dist/bolklets_code.png`
- Use one line: `<script async src="/path/to/bolklets.js"></script>`

The runtime is packaged for easy embedding:

- `dist/bolklets.js` - tiny bootstrap script
- `dist/bolklets_code.png` - packed payload (runtime code, sprites, model)

After build, adding one `<script>` tag is enough to run it on another page.

## Demo

```bash
make serve
open http://localhost:8765/web/index.html
open http://localhost:8765/dist/index.html
```

- `web/index.html` - development page (separate source files)
- `dist/index.html` - bundled page (real embed mode)

## Quick start

### Requirements

- Python 3.10+ (or any modern Python 3)
- `pip`
- Optional: `terser` (best minification) or `esbuild` (fallback)

### Build everything

```bash
make all
```

This runs:

1. `make deps` - installs Python dependencies from `tools/requirements.txt`
2. `make sprites` - extracts character sprites from `assets/people.png` and
   copies static sprites (`cave.png`, `hydra3.png`) to `build/sprites/`
3. `make model` - trains Markov model into `build/dialog_model.json` using
   Cornell corpus + in-world overlays
4. `make bundle` - builds `dist/bolklets.js` and packed
   `web/bolklets_code.png` (also copied to `dist/`)

## Use on any website

Build first:

```bash
make bundle
```

Host these two files side-by-side:

```text
dist/bolklets.js
dist/bolklets_code.png
```

Then include:

```html
<script async src="/path/to/bolklets.js"></script>
```

At runtime, bootstrap script injects required styles and stage container, then
loads `bolklets_code.png` located next to itself.

## How dialogue is generated

- Base model: Markov chain trained by `tools/train_dialog.py`
- Training sources:
  - Cornell Movie-Dialogs corpus (downloaded/cached in `corpus/`)
  - Domain overlay lines (`corpus/dialog_domain_lines.tsv`)
  - Per-character golden seeds (`corpus/golden_seeds/*.tsv`)
- Runtime generation lives in `web/js/markov.js` and orchestration in
  `web/js/dialog.js`

The system mixes Markov output with lightweight guardrails (filters, tone
biasing, reranking, and small curated fallbacks) to keep bubble text readable
while preserving variety.

## Repository layout

```text
assets/                 source art
  people.png            main character sprite sheet
  horse.png             mount sprite source
  cave.png              cave sprite source
  hydra3.png            hydra body sprite source

tools/                  Python build/training scripts
  extract_sprites.py
  train_dialog.py
  build.py
  requirements.txt

web/                    dev host page and source runtime
  index.html
  style.css
  js/
  bolklets_code.png     packed payload (generated)

build/                  intermediate artifacts (generated)
  sprites/
  dialog_model.json
  dialog-bench/         experiment outputs

dist/                   publishable bundle (generated)
  bolklets.js
  bolklets_code.png
  index.html

corpus/                 training data cache + overlays
  dialog_domain_lines.tsv
  dialog_start_banlist.txt
  golden_seeds/
```

## Make targets

```bash
make help
```

Main targets:

- `make deps` - install Python dependencies from `tools/requirements.txt`
- `make sprites` - extract/copy all sprite assets into `build/sprites/`
- `make model` - train `build/dialog_model.json` from configured corpora
- `make payload` - rebuild packed `web/bolklets_code.png`
- `make bundle` - build `dist/bolklets.js` and bundled demo artifacts
- `make all` - run full pipeline: deps + sprites + model + bundle
- `make serve` - start local static server on `http://localhost:8765`
- `make clean` - remove `dist/`
- `make distclean` - remove `dist/`, `build/`, and `corpus/`

## Credits

- Dialogue corpus: Cornell Movie-Dialogs Corpus  
  https://www.cs.cornell.edu/~cristian/Cornell_Movie-Dialogs_Corpus.html
- Font: Press Start 2P by CodeMan38  
  https://fonts.google.com/specimen/Press+Start+2P
