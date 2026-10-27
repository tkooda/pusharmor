#!/bin/sh
# Release gate for the Xcode Release configuration (a pre-build script phase).
# Fails when a project.yml setting is empty or a PLACEHOLDER, or when the app
# entitlements still say aps-environment development. Other configurations pass.
# Xcode exports the build settings as environment variables.
# Env: CONFIGURATION, SRCROOT, DEVELOPMENT_TEAM, GOOGLE_IOS_CLIENT_ID, GOOGLE_CALLBACK_SCHEME
[ "${CONFIGURATION:-}" = "Release" ] || exit 0

bad=""
check() {
  case "$2" in
    ""|*[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]*) bad="$bad
  - $1 is empty or a PLACEHOLDER" ;;
  esac
}
check DEVELOPMENT_TEAM "${DEVELOPMENT_TEAM:-}"
check GOOGLE_IOS_CLIENT_ID "${GOOGLE_IOS_CLIENT_ID:-}"
check GOOGLE_CALLBACK_SCHEME "${GOOGLE_CALLBACK_SCHEME:-}"

ent="${SRCROOT:-.}/App/PushArmor.entitlements"
if [ -f "$ent" ] && grep -A1 'aps-environment' "$ent" | grep -q '<string>development</string>'; then
  bad="$bad
  - App/PushArmor.entitlements aps-environment is development (set production in project.yml)"
fi

if [ -n "$bad" ]; then
  echo "error: release values not set:$bad" >&2
  exit 1
fi
