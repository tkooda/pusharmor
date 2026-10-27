#!/bin/sh
# Writes Config/Local.xcconfig (git-ignored) from release/local.json: the iOS
# build ids. Run before xcodegen and before a release build.
# Usage: sh tools/local-xcconfig.sh [LOCAL_JSON]
# Fails when the file is missing or a value is empty, malformed or a PLACEHOLDER.
here="$(cd "$(dirname "$0")" && pwd)"
local_json="${1:-$here/../../../release/local.json}"
out="$here/../Config/Local.xcconfig"
[ -f "$local_json" ] || { echo "error: $local_json is missing; copy release/local.example.json and fill it" >&2; exit 1; }
# Key names: release/names.json "local_keys".
python3 - "$local_json" "$out" <<'PY'
import json, re, sys
src, out = sys.argv[1], sys.argv[2]
v = json.load(open(src))
team = str(v.get("ios_development_team") or "")
cid = str(v.get("ios_google_client_id") or "")
bad = []
for k, x in (("ios_development_team", team), ("ios_google_client_id", cid)):
    if not x.strip() or "placeholder" in x.lower():
        bad.append(k + " is missing, empty or a PLACEHOLDER")
suffix = ".apps.googleusercontent.com"
if not bad and not re.fullmatch(r"[A-Z0-9]{10}", team):
    bad.append("ios_development_team is not a 10-character team id")
if not bad and not re.fullmatch(r"[A-Za-z0-9-]+" + re.escape(suffix), cid):
    bad.append("ios_google_client_id does not end in " + suffix)
if bad:
    sys.stderr.write("error: release/local.json:\n" + "".join("  - " + b + "\n" for b in bad))
    sys.exit(1)
with open(out, "w") as f:
    f.write("// Written by tools/local-xcconfig.sh from release/local.json. Do not commit.\n")
    f.write("DEVELOPMENT_TEAM = " + team + "\n")
    f.write("GOOGLE_IOS_CLIENT_ID = " + cid + "\n")
    f.write("GOOGLE_CALLBACK_SCHEME = com.googleusercontent.apps." + cid[:-len(suffix)] + "\n")
PY
