#!/usr/bin/env bash
# Build and upload iOS and macOS apps to TestFlight.
# Set ASC_KEY_ID, ASC_ISSUER_ID, ITC_TEAM_ID, and MATCH_* env vars (or use .env).
# The API key .p8 file must be at ~/private_keys/AuthKey_<ASC_KEY_ID>.p8
# Run from project root.

set -e
cd "$(dirname "$0")/.."

echo "Deploying iOS to TestFlight..."
fastlane ios beta

echo ""
echo "Deploying macOS to TestFlight..."
fastlane mac beta
