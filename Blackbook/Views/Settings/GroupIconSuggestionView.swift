import SwiftUI

struct GroupIconSuggestionView: View {
    let groupName: String
    @Binding var selectedIcon: String
    var accentColorHex: String

    @State private var suggestedIcons: [String] = SFSymbolSearchService.defaultGroupIcons
    @State private var debounceTask: Task<Void, Never>?

    private let columns = Array(repeating: GridItem(.flexible()), count: 6)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Suggested for \"\(groupName.trimmingCharacters(in: .whitespacesAndNewlines))\"")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(suggestedIcons, id: \.self) { icon in
                    Image(systemName: icon)
                        .font(.title3)
                        .frame(width: 40, height: 40)
                        .foregroundStyle(selectedIcon == icon ? .white : .primary)
                        .background(
                            selectedIcon == icon
                                ? AnyShapeStyle(Color(hex: accentColorHex) ?? .accentColor)
                                : AnyShapeStyle(Color.secondary.opacity(0.15)),
                            in: RoundedRectangle(cornerRadius: 8)
                        )
                        .onTapGesture { selectedIcon = icon }
                        .accessibilityLabel(icon)
                        .accessibilityHint("Select this icon")
                        .accessibilityAddTraits(selectedIcon == icon ? .isSelected : [])
                }
            }
        }
        .padding(.vertical, 4)
        .onChange(of: groupName) { _, newValue in
            debounceTask?.cancel()
            debounceTask = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                let results = SFSymbolSearchService.suggestIcons(
                    for: newValue,
                    defaults: SFSymbolSearchService.defaultGroupIcons
                )
                await MainActor.run {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        suggestedIcons = results
                        if let first = results.first {
                            selectedIcon = first
                        }
                    }
                }
            }
        }
    }
}
