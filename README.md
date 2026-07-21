# Whiteboard

I wanted a whiteboard that opens quickly, feels at home on Ubuntu, and does not turn every note into a cloud account. This is that app: a small Tauri whiteboard for a mouse, touchscreen, stylus, or trackpad.

It is intentionally simple. Draw, erase, zoom, pan, drop in an image, add text or LaTeX, and get back to the work in front of you. Boards autosave locally and can also be opened or saved with the normal system file picker.

## What is in the first release

- Whiteboard and blackboard themes with a light optional grid
- Pressure-aware mouse, touch, and stylus drawing
- Cursor-centered wheel and pinch zoom
- Middle-button panning and right-button selection
- Persistent keyboard substitutes for left, middle, and right mouse buttons
- A click-free Trackpad Pad that maps directly onto the visible board
- Text boxes, rendered LaTeX, and embedded PNG, JPEG, or WebP images
- Undo, redo, PNG export, native project files, and a local board library
- Password-encrypted board snapshots
- Guided handwriting practice and optional text or LaTeX recognition

New boards remember the theme, grid, current tool, ink color, pen width, Trackpad Pad mode, and mouse-button key bindings you used last.

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

The default mouse-button keys are `Z` for left, `Space` for middle, and `X` for right. Change them under Recognition settings -> Input bindings. Hold a key and move the pointer over the canvas, much like an osu-style input setup. The bindings are saved locally.

## Boards and privacy

The native Board Library stores boards in Tauri's application-data directory. On Linux, library directories use `0700` permissions and board files use `0600`. Images are embedded in the board document, so a saved board does not retain the original image path.

`Save encrypted board` creates a `.whiteboard.enc` snapshot protected with Argon2id and AES-256-GCM. The passphrase is not stored. The automatic library copy is separate and remains plaintext so it can act as local recovery.

No credentials, `.env` files, board documents, or handwriting samples belong in this repository. They are excluded by `.gitignore` and are checked before a release is published.

## Handwriting recognition

Recognition is optional. The native Rust process reads `NVIDIA_NIM_API_KEY` from the process environment or your local `~/.fcc/.env`; the key is never sent to the React interface or written into a board.

Recognition starts with the visible, grid-aligned area because that is usually the fastest useful scope. You can switch to selected ink or the whole board. Results stay editable and never replace the original writing automatically.

The practice screen collects labeled examples for letters, numbers, punctuation, words, and common math symbols. These examples guide the recognition request; this is personalization by reference, not local model fine-tuning.

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

Build the Debian package with:

```bash
npm run tauri build -- --bundles deb
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

The first release is focused on a dependable local canvas. It does not include cloud sync, collaboration, or a background service that reads raw Linux input devices.

## License

MIT. See [LICENSE](LICENSE).
