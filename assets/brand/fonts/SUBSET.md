# Font subsets

Self-hosted WOFF2 subsets for the Ocellus type system (DESIGN.md A15, §6.2,
§10; plan KTD8). `assets/brand/fonts.css` declares them. Run the script below
from the repository root to rebuild every file here; it is the exact command
that produced the committed fonts.

| File | Source | Axes kept | License |
|---|---|---|---|
| `schibsted-grotesk-var.woff2` | Schibsted Grotesk 1.100, `SchibstedGrotesk[wght].ttf` | wght 400-700 | `OFL-SchibstedGrotesk.txt` |
| `schibsted-grotesk-italic.woff2` | Schibsted Grotesk 1.100, `SchibstedGrotesk-Italic[wght].ttf` | static wght 400 | `OFL-SchibstedGrotesk.txt` |
| `martian-mono-var.woff2` | Martian Mono 1.1.0, `MartianMonoVF.ttf` | wght 400-600, wdth 87.5-100 | `OFL-MartianMono.txt` |
| `argus-glyphs.woff2` | DejaVu Sans Mono 2.37, `DejaVuSansMono.ttf` | static, 11 code points | `LICENSE-DejaVu.txt` |

Sources (official releases, checked by SHA-256 below):

- https://github.com/schibsted/schibsted-grotesk/releases/download/1.100/schibsted-grotesk-fonts.zip
- https://github.com/evilmartians/mono/releases/download/v1.1.0/martian-mono-1.1.0-variable.zip
- https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2

## Why a glyph subset

Martian Mono 1.1.0 has none of the Ocellus vocabulary glyphs (§6.7, A4, A5:
`● ⊘ ◐ ⊖ ◌ ▱ ▰ ◆ ◈ ○ □`). Schibsted Grotesk has only `○`. `argus-glyphs.woff2`
carries exactly those 11 code points from DejaVu Sans Mono, renamed to
"Argus Glyphs" as the Bitstream Vera license requires of modified fonts.
`fonts.css` attaches it to both families through `unicode-range`, so every
surface draws the vocabulary from the same outlines. The en dash used for
`skipped` (`–`) is in both brand fonts. `tests/unit/brand-assets.test.ts` fails if a
vocabulary glyph in `src/report/viewmodel.ts` has no served font.

## Character sets

- Schibsted Grotesk: Basic Latin, Latin-1, the Google Fonts "latin" extras
  (punctuation, `€`, `™`, arrows, `−`). Features: defaults plus `tnum`, `zero`, `case`.
- Martian Mono: the same, plus arrows and box drawing (DESIGN.md A15) and `✓ ✗`.
- Argus Glyphs: only the 11 vocabulary code points, no layout features.

## Command

Needs Python 3 with `fonttools` 4.66 and `brotli` (a scratch venv is enough:
`python3 -m venv .venv && .venv/bin/pip install fonttools==4.66.1 brotli`).
Set `FT` to that venv's `bin/` directory.

```sh
set -euo pipefail
export SOURCE_DATE_EPOCH=1759449600  # 2025-10-03, pins head.modified so reruns match byte for byte
FT=${FT:-.venv/bin}
OUT=assets/brand/fonts
WORK=$(mktemp -d)
cd "$WORK"
curl -sSLO https://github.com/schibsted/schibsted-grotesk/releases/download/1.100/schibsted-grotesk-fonts.zip
curl -sSLO https://github.com/evilmartians/mono/releases/download/v1.1.0/martian-mono-1.1.0-variable.zip
curl -sSLO https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2
sha256sum -c - <<'SUMS'
5a97f39b2d2185aada4790b3bbc4e2df719244daeaa656ebf8f4a4d78a95505c  schibsted-grotesk-fonts.zip
b87730975931dc2dbf0129ecf392ccaf8d29f46bc05e995703da4155db510867  martian-mono-1.1.0-variable.zip
fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7  dejavu-fonts-ttf-2.37.tar.bz2
SUMS
unzip -q schibsted-grotesk-fonts.zip -d schibsted
unzip -q martian-mono-1.1.0-variable.zip -d martian
tar xjf dejavu-fonts-ttf-2.37.tar.bz2
SG=schibsted/schibsted-grotesk-fonts/fonts/variable
cd - >/dev/null

LATIN=U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+FEFF,U+FFFD
GLYPHS=U+25CF,U+2298,U+25D0,U+2296,U+25CC,U+25B1,U+25B0,U+25C6,U+25C8,U+25CB,U+25A1
SUB="--flavor=woff2 --no-hinting --desubroutinize --name-IDs=0,1,2,3,4,5,6,13,14 --name-legacy"

"$FT/fonttools" varLib.instancer -q "$WORK/$SG/SchibstedGrotesk[wght].ttf" wght=400:700 -o "$WORK/sg.ttf"
"$FT/fonttools" varLib.instancer -q --update-name-table "$WORK/$SG/SchibstedGrotesk-Italic[wght].ttf" wght=400 -o "$WORK/sgi.ttf"
"$FT/fonttools" varLib.instancer -q "$WORK/martian/MartianMonoVF.ttf" wght=400:600 wdth=87.5:100 -o "$WORK/mm.ttf"

"$FT/pyftsubset" "$WORK/sg.ttf" $SUB --unicodes="$LATIN" \
  --layout-features+=tnum,zero,case --output-file="$OUT/schibsted-grotesk-var.woff2"
"$FT/pyftsubset" "$WORK/sgi.ttf" $SUB --unicodes="$LATIN" \
  --layout-features+=tnum,zero,case --output-file="$OUT/schibsted-grotesk-italic.woff2"
"$FT/pyftsubset" "$WORK/mm.ttf" $SUB --unicodes="$LATIN,U+2190-21FF,U+2500-257F,U+2713,U+2717" \
  --layout-features+=case --output-file="$OUT/martian-mono-var.woff2"
"$FT/pyftsubset" "$WORK/dejavu-fonts-ttf-2.37/ttf/DejaVuSansMono.ttf" $SUB --unicodes="$GLYPHS" \
  --layout-features= --output-file="$WORK/glyphs.woff2"
"$FT/python" - "$WORK/glyphs.woff2" "$OUT/argus-glyphs.woff2" <<'PY'
import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1])
names = {1: "Argus Glyphs", 2: "Regular", 3: "Argus Glyphs Regular (DejaVu Sans Mono 2.37 subset)",
         4: "Argus Glyphs Regular", 6: "ArgusGlyphs-Regular"}
for rec in f["name"].names:
    if rec.nameID in names:
        rec.string = names[rec.nameID]
f.flavor = "woff2"
f.save(sys.argv[2])
PY
cp "$WORK/dejavu-fonts-ttf-2.37/LICENSE" "$OUT/LICENSE-DejaVu.txt"
ls -l "$OUT"/*.woff2
rm -rf "$WORK"
```

OFL texts come from the same release tags (`OFL.txt` in each repository).
