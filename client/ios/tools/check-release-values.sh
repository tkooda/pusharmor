#!/bin/sh
# Release gate for the Xcode Release configuration (a pre-build script phase).
# Fails when a build id (Config/Public.xcconfig, written from release/public.json by
# tools/public-xcconfig.sh) is empty or a PLACEHOLDER, or a CI dummy
# (release/ci-dummy.mjs) without PA_CI_DUMMY=1, or unless the app
# entitlements file is readable and its aps-environment is production, or is
# $(APS_ENVIRONMENT) with the build setting APS_ENVIRONMENT=production (fail closed).
# Other configurations pass.
# Xcode exports the build settings as environment variables.
# Env: CONFIGURATION, SRCROOT, DEVELOPMENT_TEAM, GOOGLE_IOS_CLIENT_ID, GOOGLE_CALLBACK_SCHEME,
# PA_CI_DUMMY, APS_ENVIRONMENT
[ "${CONFIGURATION:-}" = "Release" ] || exit 0

bad=""
check() {
  case "$2" in
    ""|*[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]*) bad="$bad
  - $1 is empty or a PLACEHOLDER (run tools/public-xcconfig.sh)" ;;
    *[Cc][Ii]-[Ff][Oo][Rr][Kk]-[Dd][Uu][Mm][Mm][Yy]*) [ "${PA_CI_DUMMY:-}" = "1" ] || bad="$bad
  - $1 is a CI dummy (allowed only with PA_CI_DUMMY=1)" ;;
  esac
}
check DEVELOPMENT_TEAM "${DEVELOPMENT_TEAM:-}"
check GOOGLE_IOS_CLIENT_ID "${GOOGLE_IOS_CLIENT_ID:-}"
check GOOGLE_CALLBACK_SCHEME "${GOOGLE_CALLBACK_SCHEME:-}"

ent="${SRCROOT:-.}/App/PushArmor.entitlements"
aps="$(grep -A1 'aps-environment' "$ent" 2>/dev/null | sed -n 's|.*<string>\(.*\)</string>.*|\1|p' | head -n 1)"
[ "$aps" = '$(APS_ENVIRONMENT)' ] && aps="${APS_ENVIRONMENT:-}"
if [ "$aps" != "production" ]; then
  bad="$bad
  - App/PushArmor.entitlements is missing, unreadable or its aps-environment is not production (Release sets APS_ENVIRONMENT = production in project.yml)"
fi

if [ -n "$bad" ]; then
  echo "error: release values not set:$bad" >&2
  exit 1
fi
