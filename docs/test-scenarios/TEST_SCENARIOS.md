# Blackbook Test Scenarios

Running, append-only log of manual test scenarios for completed features and bug fixes. Maintained automatically — every time a feature is finished, a new dated section is added.

## Conventions

- **Append only.** Never rewrite earlier sections. If a scenario is superseded by later work, add a new dated section that references the old one.
- **Heading style:** `## YYYY-MM-DD — <feature title>` (mirrors `work_log.md`).
- **Each section includes:**
  - One-line **Summary** of what was built/fixed.
  - **Setup** — preconditions (signed-in account, data state, platform, build flavor).
  - **Steps** — numbered, specific user actions.
  - **Expected** — what success looks like for each step.
  - **Edge cases** — second-order things to verify (empty states, offline, permission denials, large data, multi-device, etc.).
  - **Platforms** — which platforms Claude built/ran vs. which still need a real-device run by the user. Be explicit about gaps.
- Keep scenarios reproducible: name exact tap paths, exact toolbar items, exact expected text. Avoid vague phrases like "verify it works".

## Section template

```
## YYYY-MM-DD — <feature title>

**Summary:** <one line>

**Setup:**
- <preconditions>

**Steps:**
1. <action> → <expected>
2. ...

**Edge cases:**
- <case> → <expected>

**Platforms:**
- iOS: <verified by Claude / needs user run>
- macOS: <verified by Claude / needs user run>
- BlackbookServer: <verified by Claude / needs user run / N/A>
```

---

<!-- Append new dated sections below this line -->
