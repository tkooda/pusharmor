#!/bin/sh
# Writes the derived Config/Public.xcconfig (git-ignored) from the tracked
# release/public.json: the iOS build ids. Run before xcodegen and before a
# release build. Debug builds work without it.
# Usage: sh tools/public-xcconfig.sh [PUBLIC_JSON]
# Fails when the file is missing or a value is empty, malformed or a PLACEHOLDER,
# or a CI dummy (release/ci-dummy.mjs) without PA_CI_DUMMY=1.
here="$(cd "$(dirname "$0")" && pwd)"
public_json="${1:-$here/../../../release/public.json}"
out="$here/../Config/Public.xcconfig"
[ -f "$public_json" ] || { echo "error: $public_json is missing" >&2; exit 1; }
# Key names: release/names.json "public_keys".
python3 - "$public_json" "$out" <<'PY'
import json, os, re, sys
src, out = sys.argv[1], sys.argv[2]
v = json.load(open(src))
team = str(v.get("apple_team_id") or "")
cid = str(v.get("google_ios_client_id") or "")
dummy_ok = os.environ.get("PA_CI_DUMMY") == "1"
dummy = lambda x: "ci-fork-dummy" in x.lower()
bad = []
for k, x in (("apple_team_id", team), ("google_ios_client_id", cid)):
    if not x.strip() or "placeholder" in x.lower():
        bad.append(k + " is missing, empty or a PLACEHOLDER")
    elif dummy(x) and not dummy_ok:
        bad.append(k + " is a CI dummy (allowed only with PA_CI_DUMMY=1)")
suffix = ".apps.googleusercontent.com"
if not bad and not dummy(team) and not re.fullmatch(r"[A-Z0-9]{10}", team):
    bad.append("apple_team_id is not a 10-character team id")
if not bad and not dummy(cid) and not re.fullmatch(r"[A-Za-z0-9-]+" + re.escape(suffix), cid):
    bad.append("google_ios_client_id does not end in " + suffix)
if bad:
    sys.stderr.write("error: release/public.json:\n" + "".join("  - " + b + "\n" for b in bad))
    sys.exit(1)
with open(out, "w") as f:
    f.write("// Written by tools/public-xcconfig.sh from release/public.json. Do not commit.\n")
    f.write("DEVELOPMENT_TEAM = " + team + "\n")
    f.write("GOOGLE_IOS_CLIENT_ID = " + cid + "\n")
    f.write("GOOGLE_CALLBACK_SCHEME = com.googleusercontent.apps." + (cid[:-len(suffix)] if cid.endswith(suffix) else cid) + "\n")
PY
