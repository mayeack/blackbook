#!/usr/bin/env bash
# Runs the collector unit tests with SwiftPM. Works with only the Command Line Tools installed
# (they ship swift-testing but not XCTest, hence the explicit framework paths).
# Synthetic data only; never touches the real chat.db, Contacts, WhatsApp or Messages.
#   collector/run-tests.sh [--filter <pattern>]
set -euo pipefail
cd "$(dirname "$0")"
DEV="$(xcode-select -p)"
FW="$DEV/Library/Developer/Frameworks"
[ -d "$FW" ] || FW="$DEV/Platforms/MacOSX.platform/Developer/Library/Frameworks"
LIB="$DEV/Library/Developer/usr/lib"
SCRATCH="${YB_SWIFT_SCRATCH:-${TMPDIR:-/tmp}/yb-collector-build}"
exec swift test --scratch-path "$SCRATCH" \
  -Xswiftc -F -Xswiftc "$FW" -Xlinker -F -Xlinker "$FW" \
  -Xlinker -rpath -Xlinker "$FW" -Xlinker -rpath -Xlinker "$LIB" "$@"
