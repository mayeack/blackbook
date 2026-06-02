# Blackbook — End-to-End Code & Design Review

**Date:** 2026-06-02
**Scope:** Full codebase (17 KLOC: 45 Views, 6 ViewModels, 11 Models, 19 Services, 9 Utilities), all design/standards docs (`CLAUDE.md`, `.cursor/rules/rules.md`, `.cursor/pages/*.md`), and the test suite.
**Baseline:** 182 XCTest + 13 Swift Testing = **195 tests, all green** (iOS + macOS) at start.
**After this review:** **219 tests, all green** (+24), both platforms build clean.

Severity: **P1** correctness/data · **P2** standards/consistency · **P3** style/nits.

> **Remediation status (updated 2026-06-02, later same day).** Four follow-up PRs landed/are open:
> - **PR #46 (merged)** — finding #6 (partial): sync apply/conflict-resolution now has 11 unit tests (`SyncApplyTests`). Network-path integration still pending.
> - **This PR** — finding #9 (`.caption2`): 16 content sites bumped to `.caption`; rules.md now documents the two narrow exceptions (icon glyphs, canvas labels). Finding #7 (stale Icon-1 48×48): rules.md corrected to 36. Finding #12 (dead code): `LocalSyncServer.swift` deleted.
> - **Still open:** #5 (nameKey whitespace), #6 (network-path tests), #8 (EntityListRow adoption), #10 (file size), #11 (Button style).

---

## 1. Overall health — strong

The codebase is in good shape and adheres to its own (unusually thorough) standards in the areas that matter most:

- **MVVM/@Observable** applied consistently; ViewModels are logic-only.
- **NavigationStack discipline is correct.** Every detail/pushed view body (`ContactDetailView`, `TagDetailView`, `GroupDetailView`, `LocationDetailView`, `ActivityDetailView`) is free of a self-owned `NavigationStack`; the only `NavigationStack`s in those files belong to sheet sub-views (`AddContactsToX`, `MetViaPickerView`, …), which is exactly per spec. **No double-back-chevron regressions.**
- **Hidden-contact filtering** (`!isHidden && !isMergedAway`) is present in every view that `@Query`s `Contact`.
- **No off-actor SwiftData access.** The only `Task.detached` is `SubscriptionManager`'s StoreKit `Transaction.updates` listener — it never touches a `ModelContext`. The class of bug behind the recent crashes is absent elsewhere.
- **No bare `Group {}`**, no `print()` (uses `os.Logger`), design tokens centralized in `AppConstants.UI`.

---

## 2. Fixed in this PR

| # | Sev | Fix |
|---|-----|-----|
| 1 | P2 | **`ContactListViewModel` removed dead `import SwiftUI`.** It imported SwiftUI but used zero SwiftUI symbols — a direct violation of "ViewModels must never import SwiftUI." |
| 2 | P2 | **`.cursor/pages/Dashboard.md` resynced with `DashboardView`.** PR #43 changed the view (`@Query`→`@State` manual fetch, title "Dashboard"→"Overview", added `ProgressView` gate + `.blackbookSyncDidComplete` refresh + the `prioritizeCard`) but did not update the page doc, violating the mandatory "Page Documentation Sync" rule. Doc now matches code. |
| 3 | P1 | **+24 unit tests for two untested, pure-logic services.** `ContactDeduplicationService` (14 tests) is *safety-critical* — it auto-merges contacts — and had zero coverage. `NetworkGraphEngine` (10 tests) covers graph build, dangling-edge rejection, tag filtering, and simulation convergence. |
| 4 | P2 | **Regression guard** `testNameKeyDoesNotTrimInnerWhitespace` documents finding #5 below. |

---

## 3. Findings to address (not changed here — need their own PR or a product decision)

### P1 / P2 — correctness & test coverage

**5. `ContactSyncService.nameKey` does not trim per-component whitespace.**
It trims only the *combined* `"first|last"` string's outer edges, so `" Hopper"` ≠ `"Hopper"` and a stray inner space defeats name-based dedup. Low incidence but real. **Proposed:** trim each component before joining. This touches a safety-critical merge path → do it in a dedicated PR with the new dedup tests as the safety net (the regression guard added here will flip when fixed).

**6. The service layer that caused the recent production bugs has ZERO unit coverage.**
`ContactSyncService` (reattach-vs-insert matching), `LocalServerSyncService` (push `syncStatus` filter, epoch bootstrap, background-context apply) — the exact code behind the sync-drift (#44) and launch-crash (#43) incidents — are untested. They're I/O-bound, so this needs light protocol seams (inject `URLSession`/a transport protocol; split the pure apply/merge logic from the network call). **Highest-value next testing investment.** Also untested: `AuthenticationService`, `GoogleCalendarService`, `SocialEnrichmentService`, `UserActionLogger`, `SubscriptionManager`, `PhotoStorageService`, `BonjourBrowser`, and `AIAssistantViewModel` (its prompt construction is pure and mockable behind a `ClaudeAPIService` protocol).

### P2 — design-standard consistency

**7. `rules.md` "Icon 1 = 48×48" contradicts the code and every other doc.**
`.cursor/rules/rules.md` describes Icon 1 as `icon1Size` **48×48**, cornerRadius 10, `.title3`, and prescribes a larger "Location Row / Location Detail" layout for prominence (lines ~236, 286, 299, 363). But `Constants.swift` defines `icon1Size = 36` ("use 36pt consistently"), and `CLAUDE.md` + `Locations.md` + the actual `LocationRowView`/`LocationDetailView` all use **36×36 / cornerRadius 8 / `.font(.body)`**. The code converged on 36; the rules.md Icon-1/Location-prominence subsections are stale. **Proposed:** delete those subsections from `rules.md` (or, if 48pt prominence is actually wanted for Locations, change the code — but the consistent direction is 36).

**8. `EntityListRow` adoption is incomplete.**
`CLAUDE.md`: "Data list rows use the shared `EntityListRow` component." Only `ActivityListView` and `MoreView` use it. `TagRowView`, `GroupRowView`, `LocationRowView` hand-roll a byte-for-byte-equivalent layout. Visually correct, but a DRY/standardization gap. **Proposed:** migrate the three collection rows to `EntityListRow` (pixel-identical, low risk).

**9. `.caption2` used in 24 places vs. "never use `.caption2` for user-facing content."**
Breakdown: `ContactListView` (9 — table pills + last-interaction date), `ActivityListView` (4), `Subscription`/`BackupRestore` (6), others (5). Some are legitimately micro (network-graph node labels, `#1` rank badges); but the **contact-table last-interaction date and the column pills are user-facing content** in violation of the "minimum readable font is `.subheadline`, floor `.caption`" rule. This is a real tension between the rule and the dense desktop-table layout. **Decision needed:** either bump these to `.caption`/`.subheadline` and let the table reflow, *or* add an explicit documented exception for "compact multi-column table metadata." Pick one and write it down so the rule and the code agree.

### P3 — style & hygiene

**10. 17 files exceed the 300-line guideline.** Worst: `SettingsView.swift` (1043 — it contains `ScoringSettingsView`, `HiddenContactsView`, `HideContactsView`, `APIKeyEntryView`, `WeightSlider`, `SettingsRow`/`SettingsIcon` all inline), `BackupService` (823), `LocalSyncServer` (718 — see #12), `ModelSyncApply` (697), `ContactListView` (684), `ContactDetailView` (649). **Proposed:** split `SettingsView`'s four sheet/sub-screens into their own files (update `project.yml`/pbxproj via `xcodegen`). Non-urgent.

**11. `Button(action: closure) { label }` in 6 places** (`InteractionLogView`, `ContactListView` ×3, `DashboardView`). These pass a stored `() -> Void` and resolve correctly to `init(action:label:)` — they compile and are not bugs — but the CLAUDE.md style rule prefers `Button { } label: { }`. Cosmetic; normalize opportunistically.

**12. `Blackbook/Services/LocalSyncServer.swift` (718 lines) is dead code.** Confirmed: the `final class LocalSyncServer` is never instantiated anywhere. The live sync handlers are in `BlackbookServer/App/BackupServer.swift`. Keeping it invites editing the wrong file (this exact confusion is recorded in the work log for PR #36). **Proposed:** delete in a dedicated cleanup PR.

---

## 4. Recommended next actions (priority order)

1. **Add service-layer sync tests** behind protocol seams (#6) — the code most likely to regress, least covered.
2. **Resolve the `.caption2` rule vs. reality** (#9) — make the standard and the code agree.
3. **Fix `nameKey` inner-whitespace** (#5) with the dedup tests as the safety net.
4. **Delete dead `LocalSyncServer.swift`** (#12) and **purge the stale Icon-1/48×48 sections from `rules.md`** (#7).
5. **Migrate the 3 collection rows to `EntityListRow`** (#8) and **split `SettingsView`** (#10).

Items 1–5 are independent and can land as separate small PRs.
