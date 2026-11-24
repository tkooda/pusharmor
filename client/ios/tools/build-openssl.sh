#!/bin/bash
# Builds COpenSSL.xcframework: OpenSSL libcrypto only (static, no libssl) from the
# openssl.org release tarball, pinned by SHA-256. PushArmorCore links it for the
# streaming AES-256-GCM file crypto (FileCrypto.swift).
# Usage: bash tools/build-openssl.sh <out dir>   (writes <out dir>/COpenSSL.xcframework)
# Needs macOS with Xcode. Slices: iOS device (arm64), iOS simulator (arm64,
# x86_64) and macOS (arm64, for swift test on the host).
# The xcframework holds PrivacyInfo.xcprivacy (tools/openssl/) and the OpenSSL
# LICENSE.txt, and is signed: with CODESIGN_IDENTITY (a keychain identity) when set,
# else with a self-signed identity made for this build in a temporary keychain.
set -euo pipefail

OPENSSL_VERSION=3.5.9
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
# The download link on openssl-library.org/source points here.
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz"
IOS_MIN=17.0
MACOS_MIN=14.0
# libcrypto only, no config file read at start, no loadable modules or engines.
OPTIONS=(no-shared no-module no-dso no-engine no-apps no-docs no-tests no-ui-console
         no-legacy no-async no-autoload-config)

here="$(cd "$(dirname "$0")" && pwd)"
[ $# = 1 ] || { echo "usage: $0 <out dir>" >&2; exit 2; }
mkdir -p "$1"
out="$(cd "$1" && pwd)/COpenSSL.xcframework"
jobs="$(sysctl -n hw.ncpu)"
work="$(mktemp -d)"
keychain=""
keychains=""
cleanup() {
  if [ -n "$keychain" ]; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s $keychains 2>/dev/null || true
    security delete-keychain "$keychain" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

curl -fsSL --retry 3 -o "$work/openssl.tar.gz" "$OPENSSL_URL"
echo "$OPENSSL_SHA256  $work/openssl.tar.gz" | shasum -a 256 -c -
tar -xzf "$work/openssl.tar.gz" -C "$work"
src="$work/openssl-$OPENSSL_VERSION"

# build <name> <Configure target> <min version flag>: an out-of-tree build of
# libcrypto.a; headers (static and generated) go to $work/<name>/include.
build() {
  local b="$work/$1"
  mkdir -p "$b/build" "$b/include/openssl"
  (cd "$b/build" && "$src/Configure" "$2" "${OPTIONS[@]}" "$3" > configure.log \
    && make -j"$jobs" build_generated > make.log && make -j"$jobs" libcrypto.a >> make.log) \
    || { tail -n 40 "$b/build/configure.log" "$b/build/make.log" 2>/dev/null; exit 1; }
  cp "$src"/include/openssl/*.h "$b/include/openssl/"
  cp "$b"/build/include/openssl/*.h "$b/include/openssl/"
  cp "$here/openssl/COpenSSL.h" "$here/openssl/module.modulemap" "$b/include/"
  echo "built $1: $(du -h "$b/build/libcrypto.a" | cut -f1)"
}
build ios "ios64-xcrun" "-mios-version-min=$IOS_MIN"
build sim-arm64 "iossimulator-arm64-xcrun" "-mios-simulator-version-min=$IOS_MIN"
build sim-x86_64 "iossimulator-x86_64-xcrun" "-mios-simulator-version-min=$IOS_MIN"
build mac "darwin64-arm64" "-mmacosx-version-min=$MACOS_MIN"

# One simulator slice holds both architectures, so their headers must match.
diff -r "$work/sim-arm64/include" "$work/sim-x86_64/include"
mkdir -p "$work/sim/build"
lipo -create "$work/sim-arm64/build/libcrypto.a" "$work/sim-x86_64/build/libcrypto.a" \
  -output "$work/sim/build/libcrypto.a"
cp -R "$work/sim-arm64/include" "$work/sim/include"

rm -rf "$out"
xcodebuild -create-xcframework \
  -library "$work/ios/build/libcrypto.a" -headers "$work/ios/include" \
  -library "$work/sim/build/libcrypto.a" -headers "$work/sim/include" \
  -library "$work/mac/build/libcrypto.a" -headers "$work/mac/include" \
  -output "$out"
# The privacy manifest at the top and in every slice, next to libcrypto.a.
cp "$here/openssl/PrivacyInfo.xcprivacy" "$src/LICENSE.txt" "$out/"
for d in "$out"/*/; do cp "$here/openssl/PrivacyInfo.xcprivacy" "$d"; done

identity="${CODESIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  keychain="$work/sign.keychain-db"
  pass="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  cat > "$work/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = PushArmor OpenSSL build
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
  # /usr/bin/openssl (LibreSSL) writes a PKCS#12 file that the macOS keychain reads.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" \
    -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
    -out "$work/id.p12" -passout "pass:$pass"
  keychains="$(security list-keychains -d user | xargs)"
  security create-keychain -p "$pass" "$keychain"
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$keychain" $keychains
  security unlock-keychain -p "$pass" "$keychain"
  security import "$work/id.p12" -k "$keychain" -P "$pass" -T /usr/bin/codesign > /dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$keychain" > /dev/null
  identity="$(/usr/bin/openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
  codesign --timestamp --keychain "$keychain" -s "$identity" "$out"
else
  codesign --timestamp -s "$identity" "$out"
fi
codesign --verify --verbose "$out"
echo "OpenSSL $OPENSSL_VERSION -> $out ($(du -sh "$out" | cut -f1))"
