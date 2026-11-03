#!/usr/bin/env bash
# PushArmor Worker deploy script. See README.md in this directory.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  deploy.sh worker/vX.Y.Z  release deploy of the tagged commit: HEAD must be
                         that tag (pushed, made by release/tag.mjs) on origin/main
  deploy.sh --help

Environment:
  CLOUDFLARE_ACCOUNT_ID  required
  WRANGLER               path to wrangler (default: worker/node_modules/.bin/wrangler)
  API_BASE               API base URL for the smoke test (default https://api.pusharmor.com/v1)
USAGE
}

die() { echo "error: $*" >&2; exit 1; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac
[ "$#" -eq 1 ] || { usage >&2; exit 2; }
TAG="$1"

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$HERE/.." && pwd)"
WORKER_DIR="$SERVER_DIR/worker"
# The git checks and the tag must target this repo, not the caller's cwd.
cd "$SERVER_DIR/.."
WRANGLER="${WRANGLER:-$WORKER_DIR/node_modules/.bin/wrangler}"
API_BASE="${API_BASE:-https://api.pusharmor.com/v1}"

# 0. release values: the repo config holds no ids and keeps the dashboard vars;
#    the deployed Worker has every dashboard var (read-only wrangler calls);
#    the bundle (wrangler deploy --dry-run) holds no test code or test route
node "$HERE/preflight.mjs" "$SERVER_DIR/.." || die "release preflight failed; nothing was deployed"
WRANGLER="$WRANGLER" node "$HERE/preflight.mjs" --dashboard "$SERVER_DIR/.." || die "dashboard preflight failed; nothing was deployed"
WRANGLER="$WRANGLER" node "$HERE/check-bundle.mjs" "$SERVER_DIR/.." || die "bundle check failed; nothing was deployed"

# 1. clean tree
[ -z "$(git status --porcelain)" ] || die "working tree is dirty (uncommitted or untracked files)"

# 2. commit on main; the worker/v tag is HEAD, pushed, and obeys release/tag.mjs
printf '%s' "$TAG" | grep -Eq '^worker/v[0-9]+\.[0-9]+\.[0-9]+$' || die "the argument must be a worker/vX.Y.Z tag"
SHA="$(git rev-parse HEAD)"
git fetch origin main
git merge-base --is-ancestor "$SHA" origin/main || die "HEAD is not on origin/main; only a commit on main can be deployed"
node release/tag.mjs --check "$TAG" >/dev/null || die "release tag check failed for $TAG"
REMOTE="$(git ls-remote --tags origin "refs/tags/$TAG^{}" | cut -f1)"
[ "$REMOTE" = "$SHA" ] || die "tag $TAG is not on origin at HEAD; push it first: git push origin $TAG"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 3. restore point: time-travel bookmark
TT_OUT="$(cd "$WORKER_DIR" && "$WRANGLER" d1 time-travel info pusharmor)"
printf '%s\n' "$TT_OUT"
BOOKMARK="$(printf '%s\n' "$TT_OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}' | head -n 1 || true)"
[ -n "$BOOKMARK" ] || die "no time-travel bookmark found in the output"
echo "=============================================="
echo "RESTORE BOOKMARK: $BOOKMARK"
echo "=============================================="

# 4. migrations
if ! (cd "$WORKER_DIR" && "$WRANGLER" d1 migrations apply pusharmor --remote); then
  echo "migration failed. restore command:" >&2
  echo "  wrangler d1 time-travel restore pusharmor --bookmark=$BOOKMARK" >&2
  exit 1
fi

# 5. deploy
rollback_hint() {
  echo "rollback: (cd server/worker && npx wrangler rollback)" >&2
  exit 1
}
(cd "$WORKER_DIR" && "$WRANGLER" deploy) || rollback_hint

# 6. smoke test
smoke() {
  local code
  code="$(curl -sS -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}' "$API_BASE/peers")" || return 1
  [ "$code" = "400" ] || { echo "smoke: expected HTTP 400, got $code" >&2; return 1; }
  [ "$(cat "$TMP/body")" = '{"error":"bad request"}' ] || { echo "smoke: unexpected body" >&2; return 1; }
  tr -d '\r' <"$TMP/headers" | grep -Eiq '^PA-Epoch: [0-9]{10}$' || { echo "smoke: PA-Epoch missing or malformed" >&2; return 1; }
  tr -d '\r' <"$TMP/headers" | grep -i '^Access-Control-Expose-Headers:' | grep -iq 'PA-Epoch' || { echo "smoke: Access-Control-Expose-Headers lacks PA-Epoch" >&2; return 1; }
}
smoke || rollback_hint
echo "smoke test passed."

# 8. done
echo "released $TAG"
