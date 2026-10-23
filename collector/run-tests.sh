#!/usr/bin/env bash
# Runs the collector unit tests with SwiftPM. Works with only the Command Line Tools installed
# (they ship swift-testing but not XCTest, hence the explicit framework paths).
# Synthetic data only; never touches the real chat.db, Contacts, WhatsApp or Messages.
# Tests run one at a time (--no-parallel; Swift Testing honors it): Vision and Network do part of their synchronous
# work on Swift's cooperative thread pool, which is only as wide as the CPU count (3 on CI). Tests that block a pool
# thread (semaphores, socket waits, a Vision call) running side by side can starve those frameworks and deadlock.
#   collector/run-tests.sh [--filter <pattern>]
set -euo pipefail
cd "$(dirname "$0")"
DEV="$(xcode-select -p)"
FW="$DEV/Library/Developer/Frameworks"
[ -d "$FW" ] || FW="$DEV/Platforms/MacOSX.platform/Developer/Library/Frameworks"
LIB="$DEV/Library/Developer/usr/lib"
SCRATCH="${YB_SWIFT_SCRATCH:-${TMPDIR:-/tmp}/yb-collector-build}"
exec swift test --no-parallel --scratch-path "$SCRATCH" \
  -Xswiftc -F -Xswiftc "$FW" -Xlinker -F -Xlinker "$FW" \
  -Xlinker -rpath -Xlinker "$FW" -Xlinker -rpath -Xlinker "$LIB" "$@"
