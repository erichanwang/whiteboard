#!/usr/bin/env bash
set -euo pipefail

task_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_cargo_binary="$(command -v cargo)"
task_cargo_root="$(cd "$(dirname "$task_cargo_binary")/.." && pwd)"
task_rustflags="--remap-path-prefix=$task_project_root=/usr/src/whiteboard --remap-path-prefix=$task_cargo_root=/usr/local/cargo"

cd "$task_project_root"
RUSTFLAGS="$task_rustflags ${RUSTFLAGS:-}" npm run tauri build -- --bundles deb
