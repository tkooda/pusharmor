#!/bin/sh
# Build and test PushArmorCore on Linux with a local Swift toolchain.
# SWIFT_BIN: directory holding swift (default: on PATH).
# SQLITE_DIR: directory with include/sqlite3.h and lib/libsqlite3.so (the system
# libsqlite3.so.0 needs a header and an unversioned link name; neither is in the repo).
set -e
cd "$(dirname "$0")"
[ -n "$SWIFT_BIN" ] && PATH="$SWIFT_BIN:$PATH"
if [ -n "$SQLITE_DIR" ]; then
  exec swift test -Xcc "-I$SQLITE_DIR/include" -Xlinker "-L$SQLITE_DIR/lib" "$@"
fi
exec swift test "$@"
