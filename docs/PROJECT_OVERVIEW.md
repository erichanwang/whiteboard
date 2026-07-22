# Whiteboard Project Overview

## Purpose

Whiteboard is a local-first desktop canvas for Ubuntu Linux. It is designed for quick handwriting, diagrams, notes, images, text, and mathematical expressions without requiring an account or cloud storage.

The application favors familiar desktop interactions, a restrained interface, and reversible edits. It supports a mouse, touchscreen, pressure-aware stylus, keyboard-based mouse substitutes, and a cursor-lock mode for touchpad use.

## Technology stack

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop shell | Tauri 2 | Native Ubuntu window, filesystem access, dialogs, commands, packaging, and CSP |
| Native backend | Rust 2021 | Board library, encryption, credential loading, and NVIDIA API requests |
| Interface | React 19 and TypeScript | Application state, tools, panels, editors, preferences, and input handling |
| Build system | Vite 7 | Frontend development server and production bundle |
| Canvas | Canvas 2D API | Strokes, images, grid, selection outlines, and export rendering |
| Equation rendering | KaTeX | In-app LaTeX preview and positioned board equations, loaded only when first used |
| Icons | Phosphor Icons | Toolbar and panel icons |
| End-to-end tests | Playwright | Browser-level interaction and persistence coverage |

The native window defaults to 1200 by 800 pixels and has a minimum size of 720 by 520 pixels.

## High-level architecture

```text
Mouse, touch, stylus, keyboard, or cursor lock
                    |
                    v
          React interaction state
                    |
          +---------+----------+
          |                    |
          v                    v
   Canvas 2D rendering    Panels and editors
          |                    |
          +---------+----------+
                    |
              BoardDocument v1
                    |
          +---------+----------+
          |                    |
          v                    v
 Browser recovery       Tauri Rust commands
                               |
                    +----------+-----------+
                    |          |           |
                    v          v           v
              Board library  Encryption  NVIDIA API
```

The React side owns the active board and interaction state. Rust is used only where native access or secret isolation is required. Board content is serialized as JSON across the Tauri command boundary.

### Runtime ownership

| State or operation | Owner | Lifetime |
| --- | --- | --- |
| Active board and viewport | React | Current window session |
| Undo and redo snapshots | React refs | Current board session, bounded by count and estimated bytes |
| Tool, theme, grid, color, width, and key bindings | Webview local storage | Across launches |
| Crash-recovery board | Webview local storage | Removed after the matching native save succeeds |
| Board Library files | Rust | Across launches in the Tauri application-data directory |
| External source files | Rust within a native dialog command | Read once; selected paths never enter the webview and never become autosave destinations |
| Recognition credential | Rust zeroizing buffers | One model-list or recognition request |
| Recognition samples and corrections | Webview local storage | Across launches until the profile is cleared |

The canvas renderer is derived state: it redraws from `BoardDocument`, the current viewport, selection, and cached decoded images. It is not a second source of truth. Pointer gestures build temporary state and commit a new immutable board only when necessary, which makes undo, autosave, and selection transforms predictable.

### Native command boundary

| Command group | Input | Output | Boundary enforced in Rust |
| --- | --- | --- | --- |
| Board Library save/open/list | Board JSON, validated board ID, or page offset | JSON board or a page of summaries | Private directory, regular files, 25 MB limit, ID/filename match, 50-row pages |
| External board import | Native Open dialog | Valid UTF-8 board JSON or cancellation | Path remains in Rust, single-open identity check, regular file, 25 MB limit |
| External encrypted import | Passphrase and native Open dialog | Decrypted board JSON or cancellation | Path remains in Rust, 25,000,080-byte ciphertext limit, authenticated header and AES-GCM tag |
| External image import | Native Open dialog | Raw binary IPC response; empty response means cancellation | Path remains in Rust, regular file, 8 MiB limit; dimensions and signature are then checked before decode |
| Encryption export | Board JSON, passphrase, default name, and native Save dialog | Saved/cancelled status or bounded error | Path remains in Rust, valid JSON, 25 MB plaintext limit, Argon2id, AES-256-GCM, and atomic private replacement |
| PNG export | Raw PNG bytes, encoded default name, and native Save dialog | Saved/cancelled status or bounded error | Path remains in Rust, `.png` extension, PNG/IHDR/IEND structure, 16 MP dimensions, 80 MiB limit, and atomic private replacement |
| Recognition | Model name, mode, and bounded data-image payloads | Recognized text | Credential isolation, request validation, timeouts, streaming 2 MiB response limit |

Each external-file command opens its native dialog and immediately performs the bounded read or atomic write inside the same Rust invocation. The selected path is never returned to React and no persistent renderer filesystem grant is created. Rust opens a selected source once and reads from the verified handle, preventing both arbitrary renderer-supplied paths and a metadata-check/read replacement race.

The one-shot commands are `open_external_board_dialog`, `open_encrypted_board_dialog`, `open_external_image_dialog`, `save_encrypted_board_dialog`, and `save_external_png_dialog`. Open-board commands return `null` on cancellation; encrypted and PNG saves return `false`. Image import uses an empty raw response for cancellation because a valid selected image cannot be empty.

## Main user features

### Drawing and navigation

- Pressure-aware freehand strokes from mouse, touch, or stylus input
- Pressure is rendered in 12 width levels so stylus variation remains visible without issuing one canvas stroke operation per sample; only width levels used by a stroke allocate paths
- Completed-stroke `Path2D` geometry is cached by immutable stroke identity and released automatically when the stroke is no longer referenced; live-stroke appends invalidate its entry
- Pen and eraser tools with persistent ink color and width
- Whiteboard and blackboard themes
- Optional minor and major grid lines
- Wheel or two-finger scroll zoom centered on the pointer
- Pinch zoom for touch input
- Middle-button panning
- Pan tool for left-button panning
- Zoom controls and a 100 percent reset
- Bottom-tool scrolling to cycle Select, Pen, Eraser, Pan, and Text

The zoom range is clamped between 25 percent and 500 percent. Grid density is reduced at distant zoom levels to keep rendering readable.

While drawing, redundant collinear points are replaced online while corners, reversals, pressure changes, the starting point, and the latest endpoint are retained. A live stroke is compacted before it exceeds 20,000 retained points. Erasing rejects strokes whose cached bounds do not reach the eraser before testing individual line segments. Selection still tests complete line segments, so simplified strokes do not develop interaction gaps.

### Selection and object editing

- Right-drag creates a rectangular selection
- Selection includes strokes, text, LaTeX objects, and embedded images
- Long stroke segments are detected even when their sampled points fall outside the selection rectangle
- A selected group can be moved by dragging its bounding box
- The bottom-right handle uniformly resizes the selected group
- Stroke points and widths, image dimensions, and text font sizes are scaled together
- Delete removes the current selection
- Clear can target content intersecting the visible viewport or the entire board

Move and resize previews are kept separate from the persisted board. Pointer movement updates only a small translation/scale descriptor; the canvas reuses the original selected geometry and cached `Path2D` objects under a transform while retaining viewport culling. The transformed points and objects are materialized once when the gesture finishes, producing one undo entry and one autosave. Cancellation leaves the board unchanged.

### Text, LaTeX, and images

- Text is added and edited with an in-app floating editor
- `Ctrl+Enter` saves the active text or LaTeX editor
- LaTeX has a live KaTeX preview before insertion
- Text and LaTeX retain editable source values in the board document
- PNG, JPEG, and WebP images can be embedded
- File signatures and dimensions are checked before browser decoding; files above 16 megapixels or 8192 pixels on either side are rejected
- Images over 1.5 MB or 2048 pixels on either side are resized as needed and stored as WebP to keep boards smaller
- Import decoding uses a temporary Blob URL rather than creating a full base64 copy first; the URL, decoded image source, and resize canvas allocation are released after preparation
- Images are stored as data URLs, so a board does not retain the original filesystem path
- Decoded image cache entries are released when their images are no longer part of the active board
- PNG export renders the current viewport, background, grid, strokes, images, and standard text fallback; the bounded PNG crosses IPC as raw bytes without a base64 round trip, then Rust opens the Save dialog and atomically replaces the selected regular file

### History

- `Ctrl+Z` undoes
- `Ctrl+Y` and `Ctrl+Shift+Z` redo
- Toolbar buttons expose Undo, Redo, and Delete Selection
- Each undo and redo stack is limited to 80 snapshots and an estimated 16 MiB, while retaining the newest snapshot
- History snapshots structurally share unchanged immutable strokes, points, text, images, and embedded image data instead of deep-copying the entire board
- Estimated snapshot sizes are cached by immutable board identity, so pruning the bounded history does not repeatedly rescan all retained points and embedded data
- A new edit clears redo history
- Undo and redo update the board modification time used by the library

Canvas redraw requests are grouped with `requestAnimationFrame`. Bursts from pointer movement, image decoding, resize events, or state changes can schedule at most one full redraw for the next display frame. Committed stroke bounds are cached by object identity, and strokes, images, and text outside the current viewport are skipped before their drawing paths are built. LaTeX and experimental-handwriting DOM overlays are also mounted only near the viewport, so distant equations do not retain KaTeX trees in the webview.

KaTeX remains lazily loaded. Its build transform retains the modern WOFF2 source for each bundled font and rejects legacy WOFF or TTF output, avoiding duplicate font payloads without changing the renderer or stylesheet rules.

The display and practice canvases retain the device pixel ratio on ordinary windows but reduce their backing resolution when necessary to stay within roughly 16 megapixels and 8192 pixels on either axis. This prevents unusually large or high-density displays from allocating hundreds of megabytes for a single RGBA canvas. PNG export uses the same effective resolution as the visible canvas.

### Cursor lock and keyboard mouse substitutes

`M` or the Lock cursor button requests Pointer Lock for the main canvas. Relative motion is multiplied by 1.35 for faster touchpad movement. The virtual cursor only draws while the left mouse or touchpad button is held. `M` or `Esc` releases the cursor.

Input settings accept multiple keyboard substitutes for each mouse button:

- Left substitute uses the current tool
- Middle substitute pans
- Right substitute selects

Defaults are `Z` for left, `Space` for middle, and `X` for right. The bindings persist locally. `M` is reserved for cursor lock.

## Board data model

The current format is `BoardDocument` version 1:

```ts
interface BoardDocument {
  version: 1;
  id: string;
  title: string;
  theme: "white" | "black";
  grid: boolean;
  strokes: Stroke[];
  textObjects: TextObject[];
  imageObjects: ImageObject[];
  updatedAt: string;
}
```

A stroke stores its color, base width, pointer type, and pressure-aware points. Points persist only coordinates and pressure; older version 1 files with unused per-point timestamps remain readable, but those timestamps are discarded to reduce JSON size and serialization work. New strokes are simplified during capture to reduce board JSON, redraw work, history size, and recognition rasterization cost. Text objects store editable text or LaTeX source, position, color, and an optional font size. Image objects store position, dimensions, and an embedded image data URL.

Imported JSON is rebuilt from validated version 1 fields rather than trusted as an application object. Non-finite coordinates and malformed strokes, points, text, and images are rejected. Numeric values and collection sizes are bounded, and image URLs are restricted to size-limited embedded PNG, JPEG, or WebP data. Older version 1 boards without image arrays or text font sizes remain readable.

## Saving and persistence

### Automatic board library

Every board change marks the interface as saving immediately. The installed Tauri app debounces native saves for 350 milliseconds and does not write a full board to synchronous webview storage on the successful path. If a native write fails, it stores the latest board as a recovery copy; if the window closes with a newer state than the last completed native save, the `beforeunload` handler also flushes that latest state. A completed native save removes any recovery copy and retains only the recent board ID. On the next launch, a recovery copy takes precedence over that marker. Browser-only development retains a local-storage board, with writes throttled to at most once per 100 milliseconds so rapid title input or eraser movement does not cause one synchronous write per event.

Native saves are serialized so a slower older write cannot overwrite a newer board state. Startup waits for recent-board restoration before autosave is enabled, preventing the temporary blank board from replacing the last native board.

On Linux:

- The board directory is created with mode `0700`
- A pre-existing symbolic link or non-directory at the board-library path is rejected before permissions or board files are written
- Board files are written with mode `0600`
- Saves use a randomly named, exclusively created private temporary file followed by rename; failed temporary writes are removed
- Board IDs are restricted to ASCII letters, numbers, and hyphens
- Individual board JSON is limited to 25 MB by the Rust command
- Library listing scans filenames and native modification times while retaining only the newest `offset + 51` candidates, then parses at most the current 50 files; exact newest-first ordering uses the board ID as a stable tie-breaker, and Newer and Older controls keep only one page in the webview at a time
- Each successful native save also writes a private metadata sidecar containing only the board ID, a bounded title, and the update time; Library pages use a fresh sidecar instead of reading the complete board, while older or stale entries fall back once to the board JSON and receive a sidecar for later listings
- A listed file must use the exact `<id>.whiteboard.json` name and contain the same document ID, so unrelated or mismatched JSON is skipped
- Library opening rechecks that the entry is a regular file, remains below 25 MB, contains valid JSON, and matches the requested board ID

The Save button writes to this preconfigured Board Library without opening a file dialog. Opening an external JSON board imports its content into the library; the source file is never modified by autosave or Save.

### Other persistence keys

| Key | Contents |
| --- | --- |
| `whiteboard.document.v1` | Browser fallback board, or temporary native crash-recovery copy |
| `whiteboard.recent-board.v1` | ID of the last successfully saved native board; no board content |
| `whiteboard.recognition.v1` | Recognition model selection, handwriting samples, corrections, and experimental font setting |
| `whiteboard.input.v1` | Left, middle, and right keyboard substitutes |
| `whiteboard.ui.v1` | Tool, ink color, width, theme, and grid preferences |

New boards keep the last theme, grid setting, current tool, ink color, and pen width. Default board titles use the local date and time.

### Encrypted snapshots

Encrypted `.whiteboard.enc` snapshots use:

- Argon2id password derivation
- 64 MiB memory cost
- 3 iterations
- 4 lanes
- AES-256-GCM authenticated encryption
- Random 16-byte salt and 12-byte nonce
- A versioned 64-byte file header authenticated as additional data
- A 25 MB plaintext board limit

Passwords are accepted only in memory and are not stored. Derived keys and password bytes use zeroizing wrappers. A wrong password or modified ciphertext fails authenticated decryption.

Opening an encrypted snapshot keeps both its selected path and ciphertext in Rust. The webview sends only the passphrase, then receives validated plaintext JSON after the same command opens the native dialog and performs authenticated decryption. This avoids exposing the path, serializing up to 25 MB of ciphertext as a JavaScript number array, or retaining a second encrypted copy in React state.

Saving an encrypted snapshot also stays inside one Rust command after the webview sends the validated board JSON, passphrase, and a default file name. Rust opens the Save dialog, encrypts into a private sibling temporary file, and renames it over the selected regular file only after the complete write succeeds. The selected path and ciphertext are never returned to JavaScript, and existing snapshots are not truncated before encryption or writing finishes.

Important: encrypted export does not replace the normal Board Library copy. The library, temporary crash recovery, and recognition profile remain separate plaintext local data.

Board Library metadata sidecars are also plaintext, but contain no stroke, image, recognition, or credential data. They live beside the already-plaintext private board files and use the same `0600` file permissions.

## Handwriting recognition

Recognition is optional and currently uses NVIDIA NIM through `https://integrate.api.nvidia.com/v1`.

The Rust process reads `NVIDIA_NIM_API_KEY` from either:

1. The process environment
2. The user's local `~/.fcc/.env`

The fallback file must be a real regular file rather than a symbolic link and is limited to 64 KiB; the selected value is limited to 8 KiB. On Unix, it must grant no permissions to group or other users (`0600` is the normal setting). Rust resolves the home directory through Tauri, verifies the opened Unix file identity, checks permissions on that same opened handle, and zeroes the temporary file contents and extracted credential when they are dropped. Non-Unix platforms retain the regular-file and size checks without a Unix mode requirement. The credential is used only by Rust for HTTPS authorization. It is not returned to React, stored in a board, or included in the repository. The target ink image is sent to NVIDIA for each recognition request. A request may also include up to 12 relevant correction hints and one reference sheet containing up to 120 locally saved handwriting samples.

### Recognition scopes

- Visible area: the default, aligned to the 32-unit grid
- Selection: selected strokes only
- Entire board: all strokes

The chosen ink is rasterized to PNG and sent to the selected vision model. Recognition rasters are limited to 1100 pixels on their longest side, including boards with very large coordinate spans. The recognition area receives a light temporary outline. Text mode asks for transcription with preserved line breaks; LaTeX mode asks for valid LaTeX without prose or delimiters.

### Feedback and personalization

Recognition results remain editable. Feedback has two paths:

- Looks correct stores the exact recognition image and returned label as a verified visual reference
- Save correction stores the same visual reference plus the original-to-corrected text pair

Feedback and practice data are stored as plaintext in webview local storage until a later recognition request. They do not fine-tune or train the remote model. Later requests may include:

- The latest 12 corrections matching the recognition mode
- A generated handwriting reference sheet containing up to 120 labeled samples

The local profile keeps up to 600 samples and 100 corrections. Loaded and newly added entries use the same validation. Individual encoded sample images are limited to 1 MiB, combined encoded sample images are limited to 4 MiB, and the complete stored profile is rejected above 8 MiB. When the image budget is reached, the newest valid samples are retained. Reference-sheet balancing reserves space for guided exercises and feedback so recent full-page feedback does not immediately displace alphabet examples. Reference-sheet images and the 26 experimental-font glyphs are decoded sequentially and released after processing. PNG dimensions are checked before decoding and limited to 2048 pixels per side and 4 megapixels.

### Guided practice

Practice sets cover:

- Lowercase alphabet
- Uppercase alphabet
- Digits 0 through 9
- Common words and letter joins
- Punctuation
- Common mathematical symbols

Each sample must be written inside the practice pad. Repeated examples increase the per-symbol count and provide more reference material.

### Experimental handwriting text

The experimental renderer unlocks after all 26 lowercase letters have at least five guided lowercase samples, requiring 130 qualifying examples.

When enabled:

- The latest qualifying sample for each lowercase letter is cropped
- Its white background is converted to a transparent mask
- Lowercase text on the board is composed from those masks
- The active board color tints each glyph for whiteboard or blackboard use
- Unsupported characters use the system font

Prepared glyphs are cached by lowercase letter and the latest qualifying sample identity. Adding unrelated feedback therefore performs no new glyph decode; replacing one letter rebuilds only that letter, deleted or invalid samples evict stale entries, and decoding remains sequential. The cache is bounded to the 26 supported lowercase letters.

This feature is a raster glyph compositor, not a generated TTF/OTF font and not a trained handwriting model. PNG export currently uses the system-font fallback.

## Native security boundaries

- Tauri Content Security Policy permits local assets, embedded data images/fonts, inline styles required by the interface, and Tauri IPC only; objects, frames, base-URL changes, and form submissions are denied
- Renderer plugin capabilities are empty; Open/Save dialogs are reachable only inside dedicated Rust commands, and no plugin filesystem command or persistent dialog-expanded path grant is exposed
- External boards, encrypted snapshots, and images are selected and opened in the same Rust command as real regular files, verified against the opened Unix file identity, and read through fixed 25 MB, 25,000,080-byte encrypted-payload, or 8 MiB limits
- Images cross IPC as raw bytes, and encrypted files are read and decrypted entirely in Rust; neither uses JSON arrays of byte-sized JavaScript numbers
- Raw encryption and decryption helpers are not exposed as renderer commands; only one-shot native-dialog encrypted-file open and atomic-save operations cross IPC
- The Board Library validates IDs before constructing filenames
- Model names and base64 image payloads are validated and size-limited in Rust
- NVIDIA requests are HTTPS-only through Rustls, refuse redirects, and apply a 10-second connection timeout, 90-second overall timeout, and 2 MiB streaming response limit
- Returned model names use the same validation as outgoing requests, are deduplicated, and are limited to 500; recognized text is limited to 32 KiB and remote error messages to 500 characters
- Encryption rejects oversized, malformed, unsupported, or unauthenticated files
- Native JSON syntax checks discard payload values instead of retaining a second in-memory JSON tree
- Release builds remap local project and Cargo paths out of the compiled binary

Before release, the source tree and Debian package must be manually scanned for credential patterns, private-key markers, `.env` files, whiteboard files, personal email, and local home paths. The build helper remaps local Rust paths but does not perform this scan automatically.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/App.tsx` | Main application state, input handling, tools, panels, editors, selection transforms, bounded history, autosave, and recognition workflow |
| `src/LatexMarkup.tsx` | Lazily loaded KaTeX renderer and stylesheet |
| `src/App.css` | Whiteboard/blackboard themes, responsive layout, tools, panels, popovers, focus states, and reduced-motion behavior |
| `src/board.ts` | Board creation/parsing, grid and canvas rendering, image-cache lifecycle, bounds, hit testing, and recognition image rendering |
| `src/image.ts` | Lazily loaded PNG, JPEG, and WebP signature and dimension inspection |
| `src/practice.ts` | Practice definitions, sample counting, and balanced reference-sheet generation |
| `src/recognition.ts` | React-to-Tauri recognition request preparation |
| `src/types.ts` | Board, stroke, text, image, sample, correction, and settings types |
| `src-tauri/src/lib.rs` | Native commands for library storage, encryption, credential loading, and NVIDIA requests |
| `src-tauri/tauri.conf.json` | Window, build, bundle, identifier, and CSP configuration |
| `src-tauri/capabilities/default.json` | Tauri command/plugin capability permissions |
| `tests/smoke.mjs` | End-to-end browser interaction suite |
| `scripts/build-release.sh` | Sanitized Debian release build with path remapping |
| `scripts/launch.sh` | Prefer release binary, then debug binary, then Tauri development mode |
| `PRODUCT.md` | Product intent, personality, constraints, and accessibility direction |

## Development workflow

Install dependencies and run the native development app:

```bash
npm install
npm run tauri dev
```

Run the frontend alone:

```bash
npm run dev -- --host 127.0.0.1
```

The Vite development server uses port 1420 and fails if that port is unavailable.

### Change map

Use the narrowest owner for a change:

| Change | Primary file | Typical paired verification |
| --- | --- | --- |
| Board schema or import validation | `src/types.ts`, `src/board.ts` | Browser smoke import and legacy normalization cases |
| Pointer, keyboard, selection, editor, or panel behavior | `src/App.tsx` | Playwright interaction case |
| Canvas rendering or geometry | `src/board.ts` | Pixel, bounds, hit-test, and culling cases |
| Practice/reference-sheet behavior | `src/practice.ts` | Sample counting, balancing, and size-limit cases |
| Native storage, encryption, or credentials | `src-tauri/src/lib.rs` | Rust unit tests plus mocked-Tauri storage flow |
| Dialog or filesystem authority | `src-tauri/capabilities/default.json` | Tauri build/schema validation and capability assertion |
| Packaging metadata or CSP | `src-tauri/tauri.conf.json` | Native build and release-package inspection |

The project intentionally keeps most interaction code together in `App.tsx`. Small pure operations move into `board.ts`, `practice.ts`, or `image.ts` when they need direct tests or are shared by rendering and interaction. There is no parallel state-management framework or service layer.

### Verification

```bash
npm run build
npm run test:e2e
cd src-tauri
cargo fmt --check
cargo test
```

The browser smoke test currently covers drawing, pressure rendering, point simplification and caps, legacy point normalization, canvas and DOM-overlay viewport culling, bounded recognition rasterization, segment hit-testing, endpoint rendering, autosave, zoom, pan, tool cycling, input bindings, persistent settings, undo/redo, exact move/resize commit and cancellation, clear scopes, practice persistence, cursor lock, in-app text/LaTeX editing and lazy loading, import validation, image-header inspection, temporary image-resource release, embedded images, incremental experimental-glyph caching, recognition feedback, responsive top-bar behavior, and browser fallback behavior. A mocked-Tauri suite separately covers recent-board restoration, successful native autosave without full-board local-storage churn, crash recovery, failed native saves, one-shot plaintext/encrypted imports and encrypted export without renderer paths, native document-ID normalization, and 50-board Library pagination in both directions. Rust unit tests cover encryption, credential-file permissions, bounded parsing and response lengths, HTTPS/redirect enforcement, atomic private saves, library identity checks, pagination, bounded PNG export, one-shot dialog helpers, and rejection of symbolic links at both file and library-directory boundaries.

### Release build

```bash
./scripts/build-release.sh
```

The helper applies Rust `--remap-path-prefix` flags before running the Tauri Debian build. The resulting package is written under `src-tauri/target/release/bundle/deb/`.

## Known limitations

- No cloud synchronization or real-time collaboration
- No background service for raw Linux touchpad coordinates
- Cursor lock uses relative movement rather than absolute touchpad contact position
- Recognition requires network access and sends selected handwriting images and the optional reference sheet to NVIDIA
- Recognition personalization is in-context visual guidance, not model fine-tuning
- Experimental handwriting text is lowercase-only and uses raster masks
- PNG export does not yet rasterize the experimental handwriting masks
- LaTeX object bounds are estimated from source length rather than measured KaTeX geometry
- Many embedded images and hundreds of handwriting samples can still pressure webview local-storage capacity, although oversized inserted images are compressed before storage
- The active release target is primarily Ubuntu AMD64 Debian packaging
- Native file opening and encrypted/PNG export use dialogs; normal board saving uses the private Board Library

## Project principles

- Keep the canvas primary
- Keep ordinary work local by default
- Make destructive actions explicit and undoable
- Keep recognition optional and reviewable
- Preserve editable source for text and equations
- Prefer familiar desktop interactions over decorative interface patterns
- Do not commit credentials, local board documents, or handwriting samples
