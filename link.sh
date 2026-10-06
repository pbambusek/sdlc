#!/usr/bin/env bash
# Symlinks every skills/<name>/ into ~/.claude/skills/<name> so Claude Code loads it as a personal skill.
set -euo pipefail
repo="$(cd "$(dirname "$0")" && pwd)"
dest="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$dest"
for dir in "$repo"/skills/*/; do
  name="$(basename "$dir")"
  target="$dest/$name"
  if [ -L "$target" ]; then
    ln -sfn "${dir%/}" "$target"
  elif [ -e "$target" ]; then
    echo "skip $name: $target exists and is not a symlink; move it away first" >&2
    continue
  else
    ln -s "${dir%/}" "$target"
  fi
  echo "linked $name -> ${dir%/}"
done
