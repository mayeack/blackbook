#!/usr/bin/env bash
# Build and upload the iOS app to TestFlight.
# Set APPLE_ID, APP_APPLE_ID, ITC_TEAM_ID, MATCH_* and FASTLANE_APP_PASSWORD (or use .env).
# Run from project root.

set -e
cd "$(dirname "$0")/.."

fastlane ios beta
