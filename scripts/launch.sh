#!/usr/bin/env bash
set -eu

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/whiteboard"
mkdir -p "$state_dir"

if [ -x "$project_dir/src-tauri/target/release/whiteboard" ]; then
  exec "$project_dir/src-tauri/target/release/whiteboard"
fi

if [ -x "$project_dir/src-tauri/target/debug/whiteboard" ]; then
  exec "$project_dir/src-tauri/target/debug/whiteboard"
fi

cd "$project_dir"
if ! npm run tauri dev >>"$state_dir/launch.log" 2>&1; then
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "Whiteboard could not start" "See $state_dir/launch.log. Ubuntu build dependencies may still be missing."
  fi
  exit 1
fi
