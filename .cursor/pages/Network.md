# Network

**Menu item:** Network
**Tab icon:** `point.3.connected.trianglepath.dotted`
**Root view:** `NetworkGraphView` in `Blackbook/Views/Network/NetworkGraphView.swift`

## Overview

The Network tab visualizes the user's contact network as a force-directed graph. Contacts appear as colored nodes connected by relationship edges. Users can filter by tag, tap nodes to select them, and add new connections between contacts.

## Pages

### NetworkGraphView

**File:** `Blackbook/Views/Network/NetworkGraphView.swift`

**Data sources:**
- `@Query(sort: \Contact.lastName)` — all contacts, filtered to exclude hidden
- `@Query` — all `ContactRelationship` records
- `@Query(sort: \Tag.name)` — all tags (for filter chips)
- `NetworkGraphViewModel` — manages graph engine, selection, connection form state

**Layout:** `NavigationStack` > `VStack(spacing: 0)`.

**Empty state:** `ContentUnavailableView` — "No Contacts" / "Add contacts to visualize your network."

**Tag filter bar:** Horizontal `ScrollView` of `FilterChip` buttons (shown when tags exist):
- "All" chip: clears tag filter
- One `TagChipView` per tag: toggles filter on/off
- Padding: horizontal + vertical 8

**Graph canvas:** `GeometryReader` > `Canvas` rendering:
- **Edges:** Gray lines (opacity 0.4, lineWidth 1) between connected nodes (filtered by visible tag set)
- **Nodes:** Colored circles filled with first tag's color (or accent gold, opacity 0.8). Radius varies by node.
- **Selected node:** White stroke ring (lineWidth 2, inset -3)
- **Labels:** First name text below each node (system size 10, weight medium), offset by `radius + 10`

**Interaction:**
- Tap gesture (`DragGesture(minimumDistance: 0).onEnded`): hit-tests nodes within `radius + 5` pixels. Sets `selectedNodeId` or clears on miss.

**Simulation:**
- Starts a `Timer` at 30fps calling `viewModel.engine.simulateStep(canvasSize:)`
- Starts on appear, stops on disappear
- `frameCounter` incremented each tick to trigger Canvas redraw

**Toolbar:** `link.badge.plus` button → presents Add Connection sheet. Disabled if < 2 contacts.

---

### Add Connection Sheet (inline)

**Defined within:** `NetworkGraphView.swift` as `.sheet(isPresented: $viewModel.showAddConnection)`

**Layout:** `NavigationStack` > `Form`:
1. **From:** Picker of all visible contacts (or "Select...")
2. **To:** Picker of contacts excluding the selected "From" contact
3. **Relationship:** TextField for label (e.g., "colleagues")

**Toolbar:** Cancel (resets form) + Add (disabled if either contact is nil)

**Save logic:** `viewModel.addConnection(context:)` — creates a `ContactRelationship` linking the two contacts with the label.

## Key ViewModel/Engine Details

- `NetworkGraphViewModel` holds: `engine: NetworkGraphEngine`, `selectedNodeId`, `filterTagIds`, `showAddConnection`, form fields
- `buildGraph(contacts:relationships:canvasSize:)` initializes nodes and edges
- `engine.simulateStep(canvasSize:)` runs force-directed layout per frame
- `engine.filteredNodes(byTagIds:)` returns nodes matching any tag in the filter set
