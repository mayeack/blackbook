# Dashboard

**Menu item:** Dashboard
**Tab icon:** `square.grid.2x2`
**Root view:** `DashboardView` in `Blackbook/Views/Dashboard/DashboardView.swift`

## Overview

The Dashboard is the app's home screen, providing an at-a-glance summary of the user's relationship network. It uses a vertical `ScrollView` with card-based layout inside a `NavigationStack`.

## Pages

### DashboardView

**File:** `Blackbook/Views/Dashboard/DashboardView.swift`

**Data sources:**
- `@Query(sort: \Contact.relationshipScore, order: .reverse)` — all contacts, filtered to exclude hidden
- `@Query(sort: \Reminder.dueDate)` — all reminders
- `DashboardViewModel` — `@State private var viewModel`

**Lifecycle:** Calls `viewModel.recalculateScores(context:)` on appear.

**Layout:** `NavigationStack` > `ScrollView` > `VStack(spacing: 20)` with `.padding()`. Navigation title: "Dashboard".

**Cards (top to bottom):**

1. **Weekly Stats Card** (`weeklyStatsCard`)
   - Title: "This Week", icon: `chart.bar.fill`, accent gold
   - Shows `StatBubble` pair: total interactions count + unique people count
   - Data from `viewModel.weeklyStats(from:)`

2. **Fading Relationships Card** (`fadingCard`)
   - Title: "Fading Relationships", icon: `arrow.down.right.circle.fill`, color: `fadingRed`
   - Empty state: "All relationships are healthy"
   - Populated: `VStack(spacing: 8)` of contact rows — `HStack(spacing: 12)` with `ContactAvatarView(size: 36)`, name `.body.weight(.medium)`, last interaction `.caption`, `ScoreBadgeView`, `.padding(.vertical, 2)`
   - Data from `viewModel.fadingContacts(from:)`

3. **Upcoming Reminders Card** (`remindersCard`)
   - Title: "Upcoming Reminders", icon: `bell.fill`, accent gold
   - Shows up to 5 incomplete reminders
   - Empty state: "No upcoming reminders"
   - Each row: title (line limit 1), contact name, due date (red if overdue)

4. **AI Assistant Card** (`aiCard`)
   - Title: "AI Assistant", icon: `sparkles`, color: purple
   - Contains a `NavigationLink` to `AIInsightsView`
   - Label: "Get AI-powered outreach suggestions" with chevron

5. **Strongest Relationships Card** (`topContactsCard`)
   - Title: "Strongest Relationships", icon: `star.fill`, color: `strongGreen`
   - Empty state: "Add contacts to see top relationships"
   - Populated: ranked list (#1, #2, etc.) in `HStack(spacing: 12)` with rank label (`.caption.weight(.bold)`, 24pt frame), `ContactAvatarView(size: 36)`, name `.body.weight(.medium)`, `ScoreBadgeView`, `.padding(.vertical, 2)`
   - Data from `viewModel.topContacts(from:)`

### DashboardCard (Reusable Component)

**File:** `Blackbook/Views/Dashboard/DashboardView.swift` (same file)

Generic card wrapper used by all dashboard cards:
- `VStack(alignment: .leading, spacing: 12)` with icon + headline title
- `frame(maxWidth: .infinity, alignment: .leading).padding()`
- Background: `AppConstants.UI.cardBackground` in `RoundedRectangle(cornerRadius: 14)`
- Parameters: `title: String`, `icon: String`, `iconColor: Color` (default accent gold), `@ViewBuilder content`

### StatBubble (Reusable Component)

**File:** `Blackbook/Views/Dashboard/DashboardView.swift` (same file)

- `VStack(spacing: 2)` with bold monospaced title2 value + caption secondary label

---

### AIInsightsView

**File:** `Blackbook/Views/Dashboard/AIInsightsView.swift`

**Data sources:**
- `@Query(sort: \Contact.relationshipScore)` — contacts, filtered to exclude hidden
- `AIAssistantViewModel` — `@State private var viewModel`

**Navigation title:** "AI Assistant"

**Unconfigured state:** `ContentUnavailableView` with "AI Not Configured" / "Add your Claude API key in Settings."

**Configured state:** Segmented picker with two tabs:

1. **Outreach Tab**
   - Button: "Get Suggestions" (or "Thinking..." while loading), `.borderedProminent`, accent gold
   - Calls `viewModel.loadOutreachSuggestions(contacts:)`
   - Results: list of `OutreachSuggestion` cards — name, priority capsule badge (high = fadingRed, else moderateAmber), reason text
   - Card style: padded VStack in `cardBackground` with `cornerRadius: 12`

2. **Network Tab**
   - Button: "Analyze Network" (or "Analyzing..." while loading), `.borderedProminent`, accent gold
   - Calls `viewModel.loadNetworkInsights(contacts:)`
   - Result: single text block in `cardBackground` with `cornerRadius: 12`

### ContactAIView (Inline Component)

**File:** `Blackbook/Views/Dashboard/AIInsightsView.swift` (same file)

Embedded in `ContactDetailView`'s AI tab. Shows per-contact AI features:

- **Unconfigured:** info label directing to Settings
- **Conversation Starters:** header + "Generate" button → `viewModel.loadConversationStarters(for:)` → list of text bubbles in `cardBackground` with `cornerRadius: 8`
- **Notes Summary:** header + "Summarize" button (disabled if no notes) → `viewModel.loadNoteSummary(for:)` → single text block in `cardBackground`
