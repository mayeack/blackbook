# Archived workflows

GitHub Actions only runs workflow files that sit directly in `.github/workflows/`. Files here are kept for reference and never run.

## testflight.yml — native app → TestFlight (archived 2026-10-20)

Blackbook no longer ships as a native iOS/macOS app (yeackbot replaces it; see `docs/design/PLAN.md`), so the TestFlight jobs left `ci.yml`. The exact original is `.github/workflows/ci.yml` at commit `2a4b02f`. This copy is a standalone workflow with the original jobs plus these fixes:

- **Tests actually run.** The original test steps used `-scheme BlackbookTests`, which was deleted on 2026-03-29 (`23c1081`). Without `set -o pipefail`, `| xcpretty` hid the error, so the steps passed without running a test. They now use `-scheme Blackbook`. The macOS test also passes a `TEST_HOST` override because the generated project uses the iOS bundle layout.
- **No cancelled uploads.** The old `cancel-in-progress: true` could kill an in-flight upload when two merges landed close together. The new `testflight` concurrency group never cancels a running upload.
- **Build numbers continue past the old workflow's.** A new workflow restarts `run_number` at 1, so the deploy adds 200. The last successful upload was iOS build 133 / macOS 100133 (2026-06-04), and `ci.yml` reached run 188.
- The deploy no longer waits on the yeackbot/collector jobs, which live in `ci.yml`. It waits only on this file's iOS + macOS app tests.
- The SPM cache step was dropped because the project has no Swift packages. The deploy's `Resolve packages` step stays as it was.
- The deploy can also be started by hand with `workflow_dispatch`, on `main` only.

### Why it was failing before it was archived

Every push to `main` from 2026-10-16 on failed at `upload_to_testflight` with this error: "A required agreement is missing or has expired." The builds and signing succeeded. Accept the pending agreement in App Store Connect (Business, or the Apple Developer Program membership) before re-enabling.

### To re-enable

1. Accept the pending agreement in App Store Connect and check that the secrets below are still valid. The ASC key, the Match password and the certs-repo PAT may have been rotated or revoked.
2. Run `git mv .github/archived-workflows/testflight.yml .github/workflows/testflight.yml`, then commit.
3. Push to `main`, or start it from the Actions tab (**TestFlight → Run workflow**).
4. Optional: drop the `app` job from `ci.yml`, because this workflow re-runs the same macOS tests.

The iOS simulator name (`iPhone 16`) and the Xcode path (`Xcode_26.3`) must exist on the runner image. Check them first if the runner has changed.

### What it uses (kept in place)

- `fastlane/` — `Fastfile` (`ios beta`, `mac beta`, `ios release`), `Appfile`, `Matchfile`.
- `scripts/deploy-testflight.sh`, for a local upload without CI.
- Repository secrets, which still exist and were not deleted:

| Secret | Purpose |
|---|---|
| `ASC_KEY_ID` | App Store Connect API key ID |
| `ASC_ISSUER_ID` | App Store Connect API issuer ID |
| `ASC_KEY_CONTENT` | Base64-encoded `.p8` API key |
| `ITC_TEAM_ID` | App Store Connect team ID |
| `MATCH_GIT_URL` | Private certs repo URL |
| `MATCH_PASSWORD` | Match encryption password |
| `MATCH_GIT_BASIC_AUTHORIZATION` | Base64 `username:PAT` for the certs repo |

`APPLE_ID`, `APP_APPLE_ID` and `FASTLANE_APP_PASSWORD` are also set but no workflow reads them. They are left over from the Apple ID and app-specific password sign-in, which `948f355` replaced with the API key.

See `DEPLOYMENT.md`, `docs/TESTFLIGHT_WALKTHROUGH.md` and the "CI/CD — GitHub Actions & Fastlane" section of `.cursor/rules/rules.md` for signing and App Store validation details.
