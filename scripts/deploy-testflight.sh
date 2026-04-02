#!/usr/bin/env bash
# Build and upload iOS and macOS apps to TestFlight.
# Set APPLE_ID, APP_APPLE_ID, ITC_TEAM_ID, MATCH_* and FASTLANE_APP_PASSWORD (or use .env).
# Run from project root.

set -e
cd "$(dirname "$0")/.."

echo "Deploying iOS to TestFlight..."
fastlane ios beta

echo ""
echo "Deploying macOS to TestFlight..."
fastlane mac beta
