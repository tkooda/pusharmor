#!/bin/sh
# Release gate for the Xcode Release configuration (a pre-build script phase).
# Fails when a build id (Config/Local.xcconfig, written from release/local.json by
# tools/local-xcconfig.sh) is empty or a PLACEHOLDER, or unless the app
# entitlements file is readable and says aps-environment production (fail closed).
# Other configurations pass.
# Xcode exports the build settings as environment variables.
# Env: CONFIGURATION, SRCROOT, DEVELOPMENT_TEAM, GOOGLE_IOS_CLIENT_ID, GOOGLE_CALLBACK_SCHEME
[ "${CONFIGURATION:-}" = "Release" ] || exit 0

bad=""
check() {
  case "$2" in
    ""|*[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]*) bad="$bad
  - $1 is empty or a PLACEHOLDER (run tools/local-xcconfig.sh)" ;;
  esac
}
check DEVELOPMENT_TEAM "${DEVELOPMENT_TEAM:-}"
check GOOGLE_IOS_CLIENT_ID "${GOOGLE_IOS_CLIENT_ID:-}"
check GOOGLE_CALLBACK_SCHEME "${GOOGLE_CALLBACK_SCHEME:-}"

ent="${SRCROOT:-.}/App/PushArmor.entitlements"
if ! grep -A1 'aps-environment' "$ent" 2>/dev/null | grep -q '<string>production</string>'; then
  bad="$bad
  - App/PushArmor.entitlements is missing, unreadable or its aps-environment is not production (set production in project.yml)"
fi

if [ -n "$bad" ]; then
  echo "error: release values not set:$bad" >&2
  exit 1
fi
