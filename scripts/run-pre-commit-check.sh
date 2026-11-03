#!/usr/bin/env bash
if command -v node >/dev/null 2>&1; then
  node scripts/check-version.js --check-bump || exit 1
  if [ -f scripts/check-readme-anchors.js ]; then
    node scripts/check-readme-anchors.js || exit 1
  fi
else
  echo "Warning: node executable not found in PATH. Skipping local version check."
fi
