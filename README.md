# Whiteboard

I wanted a whiteboard that opens quickly, feels at home on Ubuntu, and does not turn every note into a cloud account. This is that app: a small Tauri whiteboard for a mouse, touchscreen, stylus, or trackpad.

It is intentionally simple. Draw, erase, zoom, pan, drop in an image, add text or LaTeX, and get back to the work in front of you. Boards autosave to the local Board Library; external boards, encrypted snapshots, and PNG exports use native file dialogs where appropriate.

For architecture, data formats, security boundaries, recognition flow, and current limitations, see [Project Overview](docs/PROJECT_OVERVIEW.md).

## What is in the first release

- Whiteboard and blackboard themes with a light optional grid
- Pressure-aware mouse, touch, and stylus drawing
- Cursor-centered wheel and pinch zoom
- Middle-button panning and right-button selection
- Move selected content with a left drag and resize it from the corner handle
- Multiple persistent keyboard substitutes for left, middle, and right mouse buttons
- Full-canvas cursor lock with slightly accelerated movement and a visible pen tip
- Text boxes, rendered LaTeX, and embedded PNG, JPEG, or WebP images
- Undo, redo, PNG export, native project files, and a local board library
- Password-encrypted board snapshots
- Guided handwriting practice and optional text or LaTeX recognition

New boards remember the theme, grid, current tool, ink color, pen width, and mouse-button key bindings you used last.

## Controls

| Input | Action |
| --- | --- |
| Left drag | Use the current tool |
| Middle drag | Pan |
| Right drag | Select |
| Wheel or two-finger scroll | Zoom around the pointer |
| Pinch | Zoom around the gesture |
| `P`, `E`, `V`, `H`, `T` | Pen, eraser, select, hand, and text tools |
| `[` / `]` | Change pen width |
| `0` | Reset the view |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Delete` | Delete the current selection |

Scroll over the tool group in the bottom bar to cycle through Select, Pen, Eraser, Pan, and Text.

The default mouse-button keys are `Z` for left, `Space` for middle, and `X` for right. Change them under Recognition settings -> Input bindings. Each mouse button can have several alternative keys. Hold any assigned key and move the pointer over the canvas, much like an osu-style input setup. The bindings are saved locally.

Press `M` or use Lock cursor in the top bar to capture the pointer across the full canvas. Hold the left mouse or touchpad button while moving to write; press `M` or `Esc` to release the pointer. This uses relative Pointer Lock movement because normal Ubuntu webviews cannot read a touchpad's absolute contact position.

The clear control lets you remove only content intersecting the visible screen or clear the entire whiteboard. Both actions can be undone.

## Boards and privacy

The native Board Library stores boards in Tauri's application-data directory. On Linux, library directories use `0700` permissions and board files use `0600`. The normal Save button writes there without opening a file dialog. Successful native autosaves do not duplicate the full board in webview storage; a recovery copy is written only after a native save failure or when the window closes with unsaved changes. Images are embedded in the board document, so a saved board does not retain the original image path.

External board/image imports and encrypted/PNG exports use one-shot Rust dialog commands. The selected filesystem path never enters the webview, and the renderer has no dialog or filesystem plugin permissions.

The Encrypted snapshots control opens or creates a `.whiteboard.enc` copy protected with Argon2id and AES-256-GCM. The passphrase is not stored. The automatic library, temporary crash recovery, and handwriting profile are separate and remain plaintext local data.

No credentials, `.env` files, board documents, or handwriting samples belong in this repository. They are excluded by `.gitignore` and are checked before a release is published.

## Handwriting recognition

Recognition is optional. The native Rust process reads `NVIDIA_NIM_API_KEY` from the process environment or your local `~/.fcc/.env`; on Unix, that fallback file must not grant any group or other permissions (for example, use `chmod 600 ~/.fcc/.env`). The key is never sent to the React interface or written into a board.

Recognition starts with the visible, grid-aligned area because that is usually the fastest useful scope. You can switch to selected ink or the whole board. The recognized area receives a light outline. The selected ink image is sent to NVIDIA; later requests may also include correction hints and a reference sheet assembled from local samples. Results stay editable and never replace the original writing automatically. Choose Looks correct to save a positive visual reference, or edit the result and choose Save correction. These examples guide later requests; they do not train the remote model.

The practice screen collects labeled examples for letters, numbers, punctuation, words, and common math symbols. After every lowercase letter has five guided samples, an experimental display mode can compose lowercase board text from your latest samples. Unsupported characters and PNG export retain the system-font fallback. This is a raster glyph renderer, not a generated TTF or local model fine-tuning.

## Run it on Ubuntu

Install the Tauri build requirements:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config libdbus-1-dev
```

Then install dependencies and start the app:

```bash
npm install
npm run tauri dev
```

Build the Debian package with the release helper. It removes local project and Cargo paths from the compiled binary:

```bash
./scripts/build-release.sh
```

## Tests

Start the Vite server in one terminal:

```bash
npm run dev -- --host 127.0.0.1
```

Then run the build and browser-level smoke test:

```bash
npm run build
npm run test:e2e
```

### Spatial index for hit-testing and viewport culling

Large boards used to hit-test erasing and cull off-screen strokes with a linear scan of every stroke in `src/board.ts`. `eraseStrokesAt` and `drawBoard`'s viewport culling (and the rectangular-selection helper `strokesIntersectingBounds`) now narrow that scan first through a uniform-grid spatial index (`queryStrokeIndices`, cell size 512, cached per strokes array so repeated queries against an unchanged board reuse the same grid). Every consumer still runs the exact same narrow-phase check (`pointHitsStroke`, `overlapsBounds`, `intersectsBounds`) the old linear scan used, so the index only prunes candidates — it never changes which strokes match.

Run the equivalence test (asserts the spatial index returns exactly the same strokes as a linear scan, over 300 randomized point/bounds/viewport queries plus edge cases):

```bash
npm run dev -- --host 127.0.0.1   # in one terminal
node tests/spatial-index.mjs      # in another
```

Run the throughput benchmark (headless Chromium, 1K/10K/50K/100K strokes, linear scan vs the spatial index, pure hit-test/cull selection cost with no canvas painting):

```bash
node tests/spatial-index-bench.mjs
```

Measured on this machine (13th Gen Intel Core i7-1360P, 16 logical CPUs, 30 GiB RAM, Ubuntu, Node v24.16.0, Chromium 150 headless; microseconds per operation; "warm" reuses one strokes array across repeated queries, as happens across repeated erase samples or redraws while panning; "cold" rebuilds the index every call, i.e. right after an edit):

| Strokes | Linear hit-test | Spatial hit-test (warm) | Spatial hit-test (cold) | Warm speedup | Linear cull | Spatial cull (warm) | Spatial cull (cold) | Warm speedup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 63-67 us | 16-17 us | 535-605 us | ~4x | 342-418 us | 6.5-7.5 us | 595-640 us | ~45-65x |
| 10,000 | 538-560 us | 47-53 us | 2,675-3,340 us | ~11x | 1,493-1,908 us | 9-12 us | 1,875-3,030 us | ~166x |
| 50,000 | 2,709-3,154 us | 216-248 us | 13,070-13,525 us | ~11-15x | 6,209-6,633 us | 39-47 us | 14,870-18,255 us | ~134-170x |
| 100,000 | 6,503-7,934 us | 669-974 us | 31,160-35,025 us | ~7-12x | 11,731-14,251 us | 65-87 us | 26,685-35,385 us | ~164-181x |

Both linear scan and the spatial index grow with stroke count, but the index's warm cost grows much more slowly because a query only touches strokes near the query point/viewport instead of every stroke on the board. The cold cost (index rebuilt every call) is higher than a single linear scan at these sizes, so the win comes from reusing the cached index across the many repeated queries a real editing session issues before the strokes array changes (panning redraws, successive erase samples along a drag).

### Stroke simplification and compression

Strokes are simplified as they are drawn: `appendStrokePoint` in `src/board.ts` collapses near-collinear, near-constant-pressure samples online (retaining corners, reversals, pressure changes, and the stroke's start/latest point), and `compactStrokePoints` re-runs the same tolerance check over a whole stroke if it is still growing past 20,000 points. Saved/exported boards additionally go through `serializeBoard`, which rounds every number to 2 decimal places before `JSON.stringify` - stroke coordinates and pressure are already tracked at a coarser tolerance (0.012-0.6 units) than that rounding removes, so this loses no visible precision while shrinking the JSON text.

Run the benchmark (headless Chromium, synthetic handwriting: 400 strokes sampled at ~240 Hz along smooth cursive-like curves with sensor jitter and ramping pressure, fed one sample at a time through `appendStrokePoint` exactly as the live pointermove handler does):

```bash
node tests/compression-bench.mjs
```

Measured on this machine (13th Gen Intel Core i7-1360P, 16 logical CPUs, 30 GiB RAM, Ubuntu, Node v24.16.0, Chromium 150 headless):

| Stage | Points | JSON bytes | Reduction vs. raw samples |
| --- | --- | --- | --- |
| Raw pointer samples | 46,334 | 3,599,287 | - |
| After live simplification (full float precision) | 13,356 | 1,059,151 | 3.40x |
| After live simplification + `serializeBoard` rounding (actual saved format) | 13,356 | 528,396 | 6.81x |

Fidelity loss from simplification, measured as the perpendicular distance from every raw sample point to the nearest segment of the simplified polyline: **max 0.97 px, mean 0.086 px** across the 400 strokes. Both are far below one screen pixel at any normal zoom level, consistent with "no visible fidelity loss," but the measured compression ratio is **6.81x, not the 10x+ this has been described as elsewhere** - that overstated claim should be corrected. The simplification tolerance itself was left untouched to hit a number; the only change made here was the lossless `serializeBoard` rounding step, which is why the ratio moved from 3.40x to 6.81x rather than further.

The first release is focused on a dependable local canvas. It does not include cloud sync, collaboration, or a background service that reads raw Linux input devices.

## License

MIT. See [LICENSE](LICENSE).
