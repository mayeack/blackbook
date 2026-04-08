# Blackbook Deployment Guide

This document walks through deploying Blackbook to the iOS and Mac App Stores. The app runs **locally** on your devices; data is stored on-device. Optional sync between devices uses a **local Mac as sync server** (see `docs/LOCAL_MAC_SYNC_ARCHITECTURE.md`).

---

## Phase 1: Prepare the App for Production

- **Push entitlement:** `Blackbook/Blackbook.entitlements` has `aps-environment` set to `production` if using push.
- **App icon:** Ensure `Blackbook/Resources/Assets.xcassets/AppIcon.appiconset` includes a 1024×1024 px icon for the App Store.
- **Build:** Run a Release build to confirm Info.plist and signing:
  ```bash
  xcodebuild build -project Blackbook.xcodeproj -scheme Blackbook \
    -destination 'platform=iOS Simulator,name=iPhone 16' -configuration Release
  ```

---

## Phase 2: Code Signing and CI/CD

### Fastlane Match (code signing)

1. Create a **private** GitHub repository (e.g. `blackbook-certificates`).
2. Run:
   ```bash
   cd /path/to/Blackbook
   fastlane match init
   ```
   When prompted, choose **git** and enter the URL of the private repo.
3. Generate and store certificates:
   ```bash
   fastlane match appstore
   ```
   Use your Apple Developer account when prompted.
4. For macOS:
   ```bash
   fastlane match appstore --platform macos
   ```

### App Store Connect

1. In [App Store Connect](https://appstoreconnect.apple.com), create a new **iOS app** (Bundle ID: `com.blackbookdevelopment.app`, name: Blackbook).
2. Create a new **macOS app** (same or separate listing).
3. Note the **Apple ID** (numeric) for the iOS app — used as `APP_APPLE_ID` in GitHub Secrets.

### Sign in with Apple (optional)

If you enable Sign in with Apple in the app later, configure the App ID and Service ID in [Apple Developer](https://developer.apple.com).

### GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions**, add:

| Secret | Description |
|--------|-------------|
| `ASC_KEY_ID` | App Store Connect API Key ID |
| `ASC_ISSUER_ID` | App Store Connect API Issuer ID |
| `ASC_KEY_CONTENT` | Base64-encoded `.p8` API key file |
| `ITC_TEAM_ID` | App Store Connect team ID |
| `MATCH_GIT_URL` | URL of the private certificates repo |
| `MATCH_PASSWORD` | Encryption password from `match init` |
| `MATCH_GIT_BASIC_AUTHORIZATION` | Base64 of `username:personal_access_token` |

Generate base64 auth:
```bash
echo -n "your-github-username:ghp_YourToken" | base64
```

Generate the API key: Go to [App Store Connect](https://appstoreconnect.apple.com) → Users and Access → Integrations → App Store Connect API → Create key with "App Manager" role. Base64-encode the `.p8` file:
```bash
base64 -i AuthKey_XXXXXXXXXX.p8
```

---

## Phase 3: TestFlight and App Store

### Deploy to TestFlight

- **CI (recommended):** Push to `main`. The workflow in `.github/workflows/ci.yml` runs tests, then builds and uploads both iOS and macOS to TestFlight. Ensure all GitHub Actions secrets (Phase 2) are set.
- **Local:** From the project root, run `./scripts/deploy-testflight.sh` (or `fastlane ios beta` / `fastlane mac beta` individually). Requires ASC API key and Match credentials in the environment (or in `.env`).

### Test on TestFlight

- Install the build on physical devices.
- Verify contact sync, local sync (if configured), photo storage, and subscriptions.

### App Store listing

In App Store Connect, complete the items in [APPLESTORE_CHECKLIST.md](APPLESTORE_CHECKLIST.md), including:

- Screenshots (e.g. iPhone 6.7", iPad 13")
- Description, keywords, support URL, privacy policy URL
- App Review Information (demo account if needed)
- Age rating and Privacy Nutrition Labels

### Submit for review

1. **iOS:** Run `fastlane ios release` (builds, signs with Match, uploads to App Store Connect). In App Store Connect, select the new build for the version, complete any remaining metadata, and click **Submit for Review**.
2. **macOS:** The macOS build is also uploaded via `fastlane mac beta`. For App Store submission, create a new version in App Store Connect, select the macOS build, and submit for review.

---

## Security

- Do not commit the `.p8` API key file or Match password.
- See `.env.example` for a list of secrets used in CI/local (values are not stored in the repo).
