#!/usr/bin/env bash
# PushArmor Worker deploy script. See README.md in this directory.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  deploy.sh worker/vX.Y.Z  release deploy of the tagged commit: HEAD must be
                         that tag (pushed, made by release/tag.mjs) on origin/main
  deploy.sh maintenance    deploy the static 503 Worker
  deploy.sh --help

Environment:
  CLOUDFLARE_ACCOUNT_ID  required
  DB_EXPORT_MAX_BYTES    abort before the export if the remote DB is larger
                         (default 209715200 = 200 MB)
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
MODE="$1"

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$HERE/.." && pwd)"
WORKER_DIR="$SERVER_DIR/worker"
# The git checks and the tag must target this repo, not the caller's cwd.
cd "$SERVER_DIR/.."
WRANGLER="${WRANGLER:-$WORKER_DIR/node_modules/.bin/wrangler}"
API_BASE="${API_BASE:-https://api.pusharmor.com/v1}"
# The owner sets this from the measured export time. The export blocks the
# DB while it runs, so a larger DB means a longer outage.
DB_EXPORT_MAX_BYTES="${DB_EXPORT_MAX_BYTES:-209715200}"

if [ "$MODE" = "maintenance" ]; then
  "$WRANGLER" deploy --config "$HERE/maintenance/wrangler.jsonc"
  echo "Maintenance mode is live (503 on every request)."
  echo "To return to service: (cd server/worker && npx wrangler rollback)"
  echo "  or run a normal release deploy: server/deploy/deploy.sh worker/vX.Y.Z"
  exit 0
fi

TAG="$MODE"

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

# DB size guard
INFO_JSON="$(cd "$WORKER_DIR" && "$WRANGLER" d1 info pusharmor --json)"
DB_SIZE="$(printf '%s' "$INFO_JSON" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const j = JSON.parse(s);
  const v = j.file_size ?? j.database_size ?? j.size;
  if (!Number.isFinite(Number(v))) { process.exit(1); }
  console.log(String(Math.trunc(Number(v))));
});')" || die "cannot read DB size from d1 info"
echo "remote DB size: $DB_SIZE bytes (limit $DB_EXPORT_MAX_BYTES)"
[ "$DB_SIZE" -le "$DB_EXPORT_MAX_BYTES" ] || die "DB is larger than DB_EXPORT_MAX_BYTES; export aborted"

# 3. restore point: time-travel bookmark and export
TT_OUT="$(cd "$WORKER_DIR" && "$WRANGLER" d1 time-travel info pusharmor)"
printf '%s\n' "$TT_OUT"
BOOKMARK="$(printf '%s\n' "$TT_OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}' | head -n 1 || true)"
[ -n "$BOOKMARK" ] || die "no time-travel bookmark found in the output"
echo "=============================================="
echo "RESTORE BOOKMARK: $BOOKMARK"
echo "=============================================="
echo "Exporting the DB (it is blocked while the export runs)..."
(cd "$WORKER_DIR" && "$WRANGLER" d1 export pusharmor --remote --output "$TMP/pre-migration.sql")

# 4. migrations
if ! (cd "$WORKER_DIR" && "$WRANGLER" d1 migrations apply pusharmor --remote); then
  echo "migration failed. restore command:" >&2
  echo "  wrangler d1 time-travel restore pusharmor --bookmark=$BOOKMARK" >&2
  exit 1
fi

# 5. bundle hash and deploy
rollback_hint() {
  echo "rollback: (cd server/worker && npx wrangler rollback)" >&2
  exit 1
}
# The hash is of the bundle this deploy uploads (--outdir), not of a separate build.
(cd "$WORKER_DIR" && "$WRANGLER" deploy --outdir "$TMP/bundle") || rollback_hint
BUNDLE_HASH="$(cd "$TMP/bundle" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)" || rollback_hint
[ -n "$BUNDLE_HASH" ] || rollback_hint
echo "bundle sha256: $BUNDLE_HASH"

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
echo "Now send one message between peers of your own accounts."
printf 'Type "ok" when it worked (anything else prints the rollback steps): '
read -r ANSWER
if [ "$ANSWER" != "ok" ]; then
  echo "not confirmed." >&2
  rollback_hint
fi

# 8. done
echo "released $TAG (bundle sha256 $BUNDLE_HASH)"
