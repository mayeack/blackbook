#!/usr/bin/env bash
# Fastlane Match setup for Blackbook (iOS and macOS).
# Run from project root after creating a private GitHub repo for certificates.
#
# 1. Create a private repo (e.g. blackbook-certificates) on GitHub.
# 2. Set MATCH_GIT_URL (e.g. git@github.com:yourorg/blackbook-certificates.git).
# 3. Run: MATCH_GIT_URL=<url> ./scripts/setup-match.sh

set -e
cd "$(dirname "$0")/.."

if [[ -z "${MATCH_GIT_URL}" ]]; then
  echo "Set MATCH_GIT_URL to your private certificates repo URL."
  echo "Example: export MATCH_GIT_URL=git@github.com:yourorg/blackbook-certificates.git"
  exit 1
fi

echo "Initializing Match (git storage, appstore type)..."
fastlane match init

echo ""
echo "Generating and storing iOS App Store certificates..."
fastlane match appstore

echo ""
echo "Generating and storing macOS App Store certificates..."
fastlane match appstore --platform macos

echo ""
echo "Match setup complete. Add these GitHub Actions secrets:"
echo "  MATCH_GIT_URL, MATCH_PASSWORD, MATCH_GIT_BASIC_AUTHORIZATION"
echo "  APPLE_ID, APP_APPLE_ID, ITC_TEAM_ID, FASTLANE_APP_PASSWORD"
