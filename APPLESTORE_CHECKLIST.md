# App Store Submission Checklist

Use this checklist when preparing Blackbook for App Store and Mac App Store review.

## Before Submitting

- [ ] Push entitlement is set to `production` in `Blackbook/Blackbook.entitlements` (if using push).
- [ ] App icon 1024×1024 is in `Blackbook/Resources/Assets.xcassets/AppIcon.appiconset`.
- [ ] Match is set up and GitHub Actions secrets are configured (Phase 2).
- [ ] TestFlight build has been tested on physical devices (Phase 3).

## App Store Connect – iOS

- [ ] **Screenshots:** iPhone 6.7" (required), other sizes as needed (e.g. 6.5", 5.5"), iPad 13" (required for iPad).
- [ ] **Description:** App description and keywords.
- [ ] **Support URL:** Working URL for user support.
- [ ] **Privacy Policy URL:** Required; must describe data collection (contacts, photos, usage).
- [ ] **App Review Information:** Demo account if reviewers need to access the app.
- [ ] **Age Rating:** Complete the questionnaire.
- [ ] **Privacy Nutrition Labels:** Declare data collected (e.g. contact info, identifiers, usage data).

## App Store Connect – macOS

- [ ] **Screenshots:** macOS app screenshots as required.
- [ ] **Description, Support URL, Privacy Policy:** Same as iOS or platform-specific.
- [ ] **App Review Information / Age Rating / Privacy:** Same as above.

## Submit

1. **iOS:** Run `fastlane ios release`. In App Store Connect, select the new build and **Submit for Review**.
2. **macOS:** Run `fastlane mac build`, upload the build in App Store Connect, then **Submit for Review**.

See [DEPLOYMENT.md](DEPLOYMENT.md) for full deployment steps.
