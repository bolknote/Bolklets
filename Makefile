PYTHON ?= python3
PIP    ?= $(PYTHON) -m pip

# macOS `pip` refuses to install into the system interpreter without
# this flag; it's harmless on other platforms.
PIP_FLAGS ?= --break-system-packages

STATIC_SPRITES := build/sprites/cave.png build/sprites/hydra3.png
SPRITES        := $(filter-out $(STATIC_SPRITES),$(wildcard build/sprites/*.png))
JS_SRC         := $(wildcard web/js/*.js)

.PHONY: all bundle sprites static-sprites model payload serve clean distclean help deps

help:
	@echo "Targets:"
	@echo "  make deps        - install Python build + minification deps"
	@echo "  make sprites     - extract character frames from assets/people.png"
	@echo "  make model       - download corpus + train Markov model (json)"
	@echo "  make payload     - pack model + sprites into web/bolklets_code.png"
	@echo "  make bundle      - build dist/bolklets.js (minified)"
	@echo "  make all         - deps + sprites + model + bundle"
	@echo "  make serve       - run a local http server on :8765 from repo root"
	@echo "  make clean       - remove dist/"
	@echo "  make distclean   - also remove build/ (sprites + trained model) and corpus/"

all: deps sprites model bundle

deps:
	$(PIP) install $(PIP_FLAGS) -r tools/requirements.txt
	@command -v terser >/dev/null && \
	  echo "ok: terser found — best JS minification (top-level mangling, multi-pass compression)." || \
	  (command -v esbuild >/dev/null && \
	    echo "ok: esbuild found.  'npm i -g terser' would shave another ~1-2 KB on the packed PNG via top-level mangling." || \
	    echo "warning: neither terser nor esbuild found.  Install one ('npm i -g terser' for best, or 'brew install esbuild') for proper JS minification; rjsmin will be used as a whitespace-only fallback.")

sprites: $(SPRITES_STAMP) static-sprites

# GNU Make 4.3+ supports `targets &:` (one recipe -> many outputs).
# macOS still ships Make 3.81, which parses `&:` as a literal extra
# target named "&" and then warns about duplicate commands for it.
# Use a stamp file instead: the extractor runs once and touches the
# stamp, every individual sprite simply depends on the stamp.  Same
# behaviour, no warning, works on every Make >= 3.81.
SPRITES_STAMP := build/sprites/.sprites.stamp
$(SPRITES_STAMP): tools/extract_sprites.py assets/people.png assets/horse.png
	@mkdir -p build/sprites
	$(PYTHON) tools/extract_sprites.py
	@touch $@
$(SPRITES): $(SPRITES_STAMP)

# Static (non-character) sprites — currently the cave entrance and the
# three-headed hydra body — live in assets/ and are copied into
# build/sprites/ so the regular payload packer picks them up alongside
# the character frames.
static-sprites: $(STATIC_SPRITES)

STATIC_SPRITES_STAMP := build/sprites/.static-sprites.stamp
$(STATIC_SPRITES_STAMP): assets/cave.png assets/hydra3.png
	@mkdir -p build/sprites
	cp assets/cave.png build/sprites/cave.png
	cp assets/hydra3.png build/sprites/hydra3.png
	@touch $@
$(STATIC_SPRITES): $(STATIC_SPRITES_STAMP)

model: build/dialog_model.json

DIALOG_SOURCES := tools/train_dialog.py corpus/dialog_domain_lines.tsv \
  $(wildcard corpus/golden_seeds/*.tsv)

build/dialog_model.json: $(DIALOG_SOURCES)
	$(PYTHON) tools/train_dialog.py

# Both the dialogue model AND every character sprite get packed into a
# single lossless grayscale PNG (crunched with zopflipng/optipng when
# available) so the runtime only fetches one extra file after the
# bundle.  build.py produces this image as a side effect of `make
# bundle`; this target lets you rebuild it on its own.
payload: web/bolklets_code.png

# The payload image now also carries the minified bolklets runtime as
# its "js" section, so it has to rebuild whenever any source JS /
# stylesheet changes — not just when the model or sprites change.
web/bolklets_code.png: tools/build.py web/style.css build/dialog_model.json $(JS_SRC) $(SPRITES_STAMP) $(STATIC_SPRITES)
	$(PYTHON) tools/build.py

bundle: dist/bolklets.js

# The bundle depends on every source JS, the stylesheet, every sprite,
# the trained model (encoded as a PNG), and the build script itself.
# build.py minifies the JS (preferring terser for top-level identifier
# mangling and multi-pass compression, falling back to esbuild for
# whitespace + local mangling, then rjsmin for whitespace only) and the
# CSS (csscompressor) before writing dist/bolklets.js.
dist/bolklets.js: tools/build.py web/style.css build/dialog_model.json $(JS_SRC) $(SPRITES_STAMP) $(STATIC_SPRITES)
	$(PYTHON) tools/build.py

# Serve from the repo root so both the dev page (web/index.html) and
# the bundled demo (dist/index.html) are reachable on the same port.
serve:
	$(PYTHON) -m http.server 8765

clean:
	rm -rf dist

distclean: clean
	rm -rf build corpus
