#!/usr/bin/env bash
# Adds copies of a release's installers under names without a version, so
# https://github.com/<repo>/releases/latest/download/<name> always points at
# the newest installer for each platform.
set -euo pipefail
tag="$1"
work="$(mktemp -d)"
cd "$work"

copy() { # pattern, stable name
  local pattern="$1" stable="$2" found
  gh release download "$tag" --pattern "$pattern" --dir src --clobber
  found="$(find src -maxdepth 1 -type f -name "$pattern" | head -n1)"
  if [ -z "$found" ]; then
    echo "::error title=Missing installer::No asset matching $pattern in release $tag."
    exit 1
  fi
  cp "$found" "$stable"
  gh release upload "$tag" "$stable" --clobber
  echo "$stable  <-  $(basename "$found")"
}

copy '*_universal.dmg' 'W-Annotator-macOS.dmg'
copy '*_x64-setup.exe' 'W-Annotator-Windows-setup.exe'
copy '*_amd64.AppImage' 'W-Annotator-Linux.AppImage'
copy '*_amd64.deb' 'W-Annotator-Linux.deb'
