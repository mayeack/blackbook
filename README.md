# Blackbook

A cross-platform **contact and relationship management** app for iOS and macOS. Built with SwiftUI and SwiftData, Blackbook helps you stay on top of important relationships with scoring, reminders, and optional AI insights.

## Key Features

### Overview (Dashboard)
- **Weekly stats** — total interactions and unique people contacted
- **Prioritize** — pin key contacts for quick access
- **Fading relationships** — surfaces contacts you haven’t connected with recently
- **Upcoming reminders** — next follow-ups at a glance
- **AI insights** — optional Claude-powered suggestions (requires API key in Settings)
- **Strongest relationships** — top contacts by relationship score

### Contacts
- Full contact profiles: name, company, job title, emails, phones, addresses, birthday, photo
- **Relationship score** (0–100) from recency, frequency, variety, and sentiment of interactions
- **Interactions** — log calls, meetings, messages with date and notes
- **Notes** — freeform notes per contact
- **Reminders** — follow-up due dates with completion tracking
- **Smart groups** — dynamic filters (e.g. by tag, location, score)
- **Merge** — combine duplicate contacts

### Organization
- **Tags** — label contacts with custom tags (icon + color)
- **Groups** — folders of contacts
- **Locations** — places linked to contacts (e.g. “Coffee shop”, “Office”)

### Activities
- **Activities** — event types (e.g. “Lunch”, “Call”) with date and linked contacts
- **Google Calendar** — optional calendar integration; rejected events stored for reference

### Network
- **Network graph** — visualize how contacts connect (e.g. “Met via”, “Introduced to”)

### Sync
- **Local Mac sync** — one Mac acts as the sync server; other devices (iPhone, iPad, other Macs) sync with it over the network (Bonjour discovery or manual URL). Data and photos live on the Mac; no cloud account required.
- See [docs/LOCAL_MAC_SYNC_ARCHITECTURE.md](docs/LOCAL_MAC_SYNC_ARCHITECTURE.md) for design.

### Security & Access
- **Authentication** — email/password and Sign in with Apple (when using cloud backend)
- **Biometric lock** — optional Face ID / Touch ID to unlock the app
- **Keychain** — API keys and sync credentials stored in Keychain

### Subscriptions
- **Pro** — monthly and yearly in-app subscriptions; free tier has a contact limit (see `AppConstants.Subscription`).

## Tech Stack

- **SwiftUI** — UI on iOS and macOS
- **SwiftData** — local persistence (SQLite-backed)
- **MVVM** — `@Observable` ViewModels, no SwiftUI in ViewModels
- **Contacts / ContactSyncService** — optional system Contacts sync
- **StoreKit** — subscriptions

## Project Structure

```
Blackbook/
  App/           — BlackbookApp, ContentView, AppTab
  Models/        — Contact, Interaction, Note, Tag, Group, Location, Reminder, Activity, etc.
  ViewModels/    — one per major screen
  Views/         — SwiftUI views by feature (Dashboard, Contacts, Tags, Groups, …)
  Services/      — Auth, sync, scoring, AI, calendar, photos, reminders
  Utilities/     — Keychain, constants, date helpers, sync types
```

## Requirements

- Xcode 26+ (project format 77)
- iOS 18+ / macOS 15+ (or as set in the project)
- For TestFlight/App Store: see [DEPLOYMENT.md](DEPLOYMENT.md)

## Building

1. Open `Blackbook.xcodeproj` in Xcode.
2. Select the **Blackbook** scheme and your target (iOS Simulator or My Mac).
3. Build and run (⌘R).

New `.swift` files must be registered in `Blackbook.xcodeproj/project.pbxproj` (PBXFileReference, PBXBuildFile, PBXGroup, PBXSourcesBuildPhase).

## Documentation

- [LOCAL_MAC_SYNC_ARCHITECTURE.md](docs/LOCAL_MAC_SYNC_ARCHITECTURE.md) — sync server design
- [DEPLOYMENT.md](DEPLOYMENT.md) — production and TestFlight deployment
- `.cursor/rules/rules.md` — project conventions, UI tokens, and CI/CD
- `.cursor/pages/*.md` — per-page behavior and layout (kept in sync with Views)
