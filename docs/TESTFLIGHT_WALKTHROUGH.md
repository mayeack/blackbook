# TestFlight Walkthrough: Test Blackbook on Your iPhone

Follow these steps to install and test Blackbook on your iPhone via TestFlight.

---

## Prerequisites

- **Apple Developer Program** membership ($99/year) — required for TestFlight.
- **Mac** with Xcode and the Blackbook project.
- **iPhone** with a working Apple ID (same one as your developer account is fine).

---

## Part 1: One-time setup

### 1. Create the app in App Store Connect

1. Go to [App Store Connect](https://appstoreconnect.apple.com) and sign in.
2. Click **My Apps** → **+** → **New App**.
3. Choose **iOS**, platform **Apple iOS**.
4. Fill in:
   - **Name:** Blackbook
   - **Primary Language:** English (or your choice)
   - **Bundle ID:** Select **com.blackbookdevelopment.app** (create it under [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) if it doesn’t exist).
   - **SKU:** e.g. `blackbook-ios-1`
5. Click **Create**.

Note the app’s **Apple ID** (numeric) on the app’s **App Information** page — you’ll use it as `APP_APPLE_ID`.

### 2. Set up code signing with Match

1. Create a **private** GitHub repo (e.g. `blackbook-certificates`). Do not initialize with a README if you want an empty repo.
2. In Terminal, from your Blackbook project root:
   ```bash
   cd /Users/mayeack/Blackbook
   fastlane match init
   ```
3. Choose **git** and enter the clone URL of the private repo (e.g. `https://github.com/yourusername/blackbook-certificates.git`).
4. Generate and download the distribution certificate and provisioning profile:
   ```bash
   fastlane match appstore
   ```
5. When prompted, sign in with your **Apple ID** (developer account). Match will create the certificate and profile and store them in the repo.

### 3. Create an app-specific password (for Fastlane)

1. Go to [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security** → **App-Specific Passwords**.
2. Click **+** to generate a new password. Name it e.g. “Fastlane Blackbook”.
3. Copy the generated password (you won’t see it again).

### 4. Configure environment variables

1. In the Blackbook project root, copy the example env file:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` and set (do not commit `.env`):
   ```bash
   APPLE_ID=your@email.com
   APP_APPLE_ID=1234567890
   ITC_TEAM_ID=123456789
   MATCH_GIT_URL=https://github.com/yourusername/blackbook-certificates.git
   MATCH_PASSWORD=your_match_encryption_password
   MATCH_GIT_BASIC_AUTHORIZATION=base64_username_token
   FASTLANE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```
   - **APP_APPLE_ID:** The numeric Apple ID of the Blackbook app from App Store Connect (Step 1).
   - **ITC_TEAM_ID:** In App Store Connect, go to **Users and Access** → **Keys** or your team; the Team ID is shown there (numeric).
   - **MATCH_PASSWORD:** A password you choose for Match (used to encrypt the certs repo). Remember it for future runs.
   - **MATCH_GIT_BASIC_AUTHORIZATION:** For private repo access. Generate with:
     ```bash
     echo -n "your-github-username:ghp_YourPersonalAccessToken" | base64
     ```
     Use a GitHub Personal Access Token with `repo` scope.

---

## Part 2: Upload a build to TestFlight

From the Blackbook project root in Terminal:

```bash
cd /Users/mayeack/Blackbook
fastlane ios beta
```

What this does:

1. Runs `match` to install the App Store certificate and provisioning profile.
2. Increments the build number (date-based if not set).
3. Builds the app for **App Store distribution** (Release, signed).
4. Uploads the build to App Store Connect for TestFlight.

If something fails:

- **“Could not find profile”** — Run `fastlane match appstore` again and ensure the repo and password are correct.
- **“Invalid credentials”** — Check `APPLE_ID` and `FASTLANE_APP_PASSWORD` (app-specific password, not your normal Apple ID password).
- **“No such file or directory”** — Ensure you’re in the project root and the Xcode project/scheme name is correct.

After a successful upload, the build appears in App Store Connect under **TestFlight** in a few minutes (sometimes 5–15).

---

## Part 3: Add yourself as a tester

### Internal testing (just you / your team)

1. In [App Store Connect](https://appstoreconnect.apple.com) → **My Apps** → **Blackbook**.
2. Open the **TestFlight** tab.
3. Under **Internal Testing**, click **+** to create a group if needed (e.g. “Developers”).
4. Add your Apple ID email (and any teammates). Internal testers get new builds immediately; no App Review.

You (and they) will get an email when a new build is available.

### External testing (optional, for others)

1. Under **TestFlight** → **External Testing**, create a group and add testers by email.
2. Submit the build for **Beta App Review** (first time can take ~24 hours). After approval, invited testers receive an email to join TestFlight.

---

## Part 4: Install on your iPhone

1. On your **iPhone**, open the **App Store** and install **TestFlight** (by Apple) if you don’t have it.
2. Sign in to TestFlight with the **same Apple ID** you added as an internal tester.
3. Wait for the “Blackbook is ready to test” email, or open **TestFlight** and look for **Blackbook** under **Apps**.
4. Tap **Blackbook** → **Install**. Accept any prompts.
5. When installation finishes, tap **Open** to launch Blackbook.

You can now use the app like a normal install. Updates: upload a new build with `fastlane ios beta`; TestFlight will show an update for Blackbook when it’s processed.

---

## Quick reference

| Step | Action |
|------|--------|
| One-time | Create app in App Store Connect, run `match init` + `match appstore`, create app-specific password, fill `.env` |
| Each build | `fastlane ios beta` from project root |
| On iPhone | Install TestFlight app → sign in → install Blackbook from TestFlight |

For full deployment details (including macOS and release), see [DEPLOYMENT.md](../DEPLOYMENT.md).
