#!/usr/bin/env bash
# F-Droid repo https://fdroid.pusharmor.com/repo, served from the R2 bucket
# pusharmor-fdroid (android-release.yml, job android-rel-fdroid). It holds the
# foss APKs of the newest three Android releases.
#   release/fdroid/publish.sh build WORK
#     The foss APKs of the newest three android/vX.Y.Z tags up to VERSION, from
#     their GitHub releases (checked against each release hashes file), and the
#     index signed with the repo key, in WORK/repo. The keystore is removed at
#     the end. env VERSION, GH_TOKEN, GH_REPO, FDROID_REPO_KEYSTORE_B64,
#     FDROID_REPO_STORE_PASSWORD, FDROID_REPO_KEY_PASSWORD; fdroid (fdroidserver),
#     apksigner and keytool on PATH.
#   release/fdroid/publish.sh upload WORK
#     WORK/repo to the bucket, the index files last, never repo/status/ (it
#     holds local paths); then deletes the foss APKs of older releases from the
#     bucket. env VERSION, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID;
#     wrangler on PATH.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
BUCKET=pusharmor-fdroid
KEEP=3
ALIAS=pusharmor-fdroid-repo
# SHA-256 of the repo signing certificate, as published on /download.
FINGERPRINT=262c4f2e9a0220ed48181a5c8650dd742372b220e628fe10e7eea2e9fe6ce4e3
# Index files, uploaded last and in this order (entry.* points at the others).
INDEX="index-v2.json index-v1.json index-v1.jar index.xml index.jar entry.json entry.jar"

mode="${1:-}"
work="${2:-}"
[ -n "$work" ] && [ -n "${VERSION:-}" ] || { echo "usage: VERSION=X.Y.Z $0 build|upload WORK" >&2; exit 2; }

# Versions of the android/vX.Y.Z tags up to VERSION, oldest first.
versions() {
  git -C "$root" tag -l 'android/v*' | sed 's#^android/v##' | sort -V | awk -v v="$VERSION" '{ print } $0 == v { exit }'
}

build() {
  rm -rf "$work"
  mkdir -p "$work/repo" "$work/dl"
  cp "$here/config.yml" "$work/config.yml"
  chmod 600 "$work/config.yml"
  cp -r "$here/metadata" "$work/metadata"
  mkdir -p "$work/metadata/com.pusharmor/en-US/phoneScreenshots"
  cp "$root"/store/screenshots/play/en-US/*.png "$work/metadata/com.pusharmor/en-US/phoneScreenshots/"
  cp "$here/metadata/com.pusharmor/en-US/icon.png" "$work/pusharmor.png"
  for v in $(versions | tail -n "$KEEP"); do
    d="$work/dl/$v"
    gh release download "android/v$v" -D "$d" -p "pusharmor-$v-foss.apk" -p "pusharmor-$v.hashes.txt"
    (cd "$d" && grep -E "^[0-9a-f]{64}  pusharmor-$v-foss\.apk\$" "pusharmor-$v.hashes.txt" | sha256sum -c -)
    cp "$d/pusharmor-$v-foss.apk" "$work/repo/"
  done
  trap 'rm -f "$work/keystore.p12"' EXIT
  (umask 077 && printf '%s' "$FDROID_REPO_KEYSTORE_B64" | base64 -d > "$work/keystore.p12")
  got="$(keytool -exportcert -alias "$ALIAS" -keystore "$work/keystore.p12" -storetype PKCS12 \
    -storepass:env FDROID_REPO_STORE_PASSWORD | sha256sum | cut -d' ' -f1)"
  if [ "$got" != "$FINGERPRINT" ]; then
    echo "::error::the repo keystore certificate SHA-256 is $got, not the published $FINGERPRINT"
    exit 1
  fi
  (cd "$work" && fdroid update)
  if grep -rlF "$work" "$work/repo" --exclude-dir=status; then
    echo "::error::the repo files above hold the local path $work"
    exit 1
  fi
}

put() {
  local ct
  case "$1" in
    *.apk) ct=application/vnd.android.package-archive ;;
    *.jar) ct=application/java-archive ;;
    *.json) ct=application/json ;;
    *.xml) ct=application/xml ;;
    *.png) ct=image/png ;;
    *.html) ct="text/html; charset=utf-8" ;;
    *.css) ct=text/css ;;
    *) ct=application/octet-stream ;;
  esac
  wrangler r2 object put "$BUCKET/$1" --file "$1" --content-type "$ct" --remote
}

upload() {
  cd "$work"
  for f in $INDEX; do
    test -s "repo/$f" || { echo "::error::repo/$f is missing"; exit 1; }
  done
  find repo -type f -not -path 'repo/status/*' | sort | while read -r f; do
    case " $INDEX " in *" ${f#repo/} "*) continue ;; esac
    put "$f"
  done
  for f in $INDEX; do put "repo/$f"; done
  for v in $(versions | head -n "-$KEEP"); do
    wrangler r2 object delete "$BUCKET/repo/pusharmor-$v-foss.apk" --remote ||
      echo "::warning::could not delete repo/pusharmor-$v-foss.apk from $BUCKET"
  done
}

case "$mode" in
  build) build ;;
  upload) upload ;;
  *) echo "usage: VERSION=X.Y.Z $0 build|upload WORK" >&2; exit 2 ;;
esac
