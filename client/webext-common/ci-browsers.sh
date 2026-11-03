#!/bin/bash
# CI only: pinned Firefox and Chrome for the popup and screenshot checks, so a
# runner image update does not change the browsers. Each download is checked
# against its SHA-256 below. Puts `firefox` and `google-chrome` (Chrome for
# Testing) first on PATH for the next steps. geckodriver stays the runner's.
# Bump: new versions here; Firefox SHA-256 from
# https://archive.mozilla.org/pub/firefox/releases/<version>/SHA256SUMS
# (linux-x86_64/en-US/firefox-<version>.tar.xz), Chrome from sha256sum of the
# downloaded chrome-linux64.zip.
# Usage: bash ci-browsers.sh firefox|chrome...
set -euo pipefail

FIREFOX_VERSION="158.0.1"
FIREFOX_SHA256="dce45470139242cf294eb6ada3d192a9bb334696842b02b71ade448a139eb41a"
CHROME_VERSION="155.0.8059.84"
CHROME_SHA256="cf0f049892dea22e6a6db26d47ed0d7776b7158edcbec4634086633df8bafcbc"

d="$RUNNER_TEMP/browsers"
mkdir -p "$d/bin"
for b in "$@"; do
  case "$b" in
    firefox)
      f="$d/firefox-$FIREFOX_VERSION.tar.xz"
      curl -fsSL -o "$f" "https://archive.mozilla.org/pub/firefox/releases/$FIREFOX_VERSION/linux-x86_64/en-US/firefox-$FIREFOX_VERSION.tar.xz"
      echo "$FIREFOX_SHA256  $f" | sha256sum -c -
      tar -xJf "$f" -C "$d"
      ln -sf "$d/firefox/firefox" "$d/bin/firefox"
      ;;
    chrome)
      f="$d/chrome-linux64-$CHROME_VERSION.zip"
      curl -fsSL -o "$f" "https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/linux64/chrome-linux64.zip"
      echo "$CHROME_SHA256  $f" | sha256sum -c -
      unzip -q "$f" -d "$d"
      ln -sf "$d/chrome-linux64/chrome" "$d/bin/google-chrome"
      # Ubuntu 24.04 runners allow user namespaces only to programs with an
      # AppArmor profile (the runner's own Chrome has one); this download gets
      # Chrome's setuid sandbox helper instead, so it still runs sandboxed.
      sudo chown root:root "$d/chrome-linux64/chrome_sandbox"
      sudo chmod 4755 "$d/chrome-linux64/chrome_sandbox"
      echo "CHROME_DEVEL_SANDBOX=$d/chrome-linux64/chrome_sandbox" >> "$GITHUB_ENV"
      ;;
    *)
      echo "usage: ci-browsers.sh firefox|chrome..." >&2
      exit 2
      ;;
  esac
done
echo "$d/bin" >> "$GITHUB_PATH"
