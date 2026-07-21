# Whiteboard

A local-first Tauri whiteboard for Ubuntu. It supports mouse, touch, stylus pressure, whiteboard and blackboard themes, a subtle grid, vector undo/redo, selection, panning, cursor-centered zoom, native project files, PNG export, and autosave.

Mouse controls:

- Left drag: draw with the current tool
- Middle drag: pan regardless of the selected tool
- Right drag: select strokes regardless of the selected tool
- Wheel, two-finger scroll, or pinch: zoom around the cursor
- Hold configurable Draw, Pan, or Select keys while moving the cursor for osu-style button-free input

The Text tool inserts a text box at the clicked board position. Click an existing text box with the Text tool to edit it. The top bar can also embed a local PNG, JPEG, or WebP image and insert a KaTeX-rendered LaTeX object at the visible board center. Embedded images stay inside the board document rather than retaining a local file path.

New boards keep the last board theme, grid, tool, ink color, pen width, and click-free Trackpad Pad preference.

## Board Library and files

New boards receive a sortable local date-time name. The native Board Library autosaves each board as a private JSON file in Tauri's application-data directory. Library directories use `0700` permissions and board files use `0600` on Linux.

`Open`, `Save`, and PNG export use native system file dialogs for files outside the library. Board data and handwriting samples are never stored in this repository.

`Save encrypted board` creates a password-protected `.whiteboard.enc` snapshot using Argon2id with a 64 MiB memory cost and AES-256-GCM authenticated encryption. The passphrase is never stored. The private autosave library remains a separate plaintext recovery copy.

## Recognition

Recognition uses the NVIDIA NIM API. The native Rust layer reads `NVIDIA_NIM_API_KEY` from the process environment or `~/.fcc/.env`; the credential is never returned to the React interface or saved in board files.

Recognition defaults to the currently visible grid-aligned area for smaller, faster requests. The panel can switch to selected ink or the entire board. Text and LaTeX results remain editable and never replace the original ink automatically.

The handwriting profile stores up to 240 labeled samples and 100 corrections locally. Guided exercises cover lowercase and uppercase letters, digits, words, punctuation, and math symbols. Balanced recent examples are sent to the vision model; this is reference-based personalization, not neural-network fine-tuning.

## Trackpad Pad

`Trackpad Pad` maps positions inside its on-screen writing area edge-to-edge onto the visible board. Press and drag, or enable click-free writing and move the cursor through the pad without clicking.

Ubuntu and Wayland do not expose raw absolute touch-contact coordinates to a normal webview. A true no-click physical-touchpad mode would require a Rust evdev/libinput reader and a one-time, device-specific OS permission rule. The app does not run as root or silently broaden input-device access.

## Ubuntu setup

Install Tauri's Linux build requirements:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config libdbus-1-dev
```

Then run:

```bash
npm install
npm run tauri dev
```

Build an installable package with:

```bash
npm run tauri build -- --bundles deb
```

## Verification

```bash
npm run build
npm run dev -- --host 127.0.0.1
npm run test:e2e
```

## Feature backlog

- SVG and PDF export
- Shapes and line snapping
- Image and PDF backgrounds
- Multiple pages and version history
- Search across recognized notes
- Handwriting to Markdown or tasks
- Formula alignment, matrices, and equation numbering
- Presentation mode
- Optional real model fine-tuning with held-out accuracy evaluation

Cloud sync, real-time collaboration, and an infinite canvas are intentionally outside the first release.

## Desktop launcher

The user-level application entry can use the generated icon in `src-tauri/icons/icon.png` and the portable `scripts/launch.sh` launcher.

## Privacy

Credentials are read at runtime and are never embedded in the frontend or board files. `.env` files, private keys, generated builds, logs, native board files, and application data are excluded by `.gitignore`.
