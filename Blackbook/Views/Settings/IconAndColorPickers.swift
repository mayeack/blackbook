import SwiftUI

struct CollapsibleIconPicker: View {
    let categories: [AppConstants.Icons.Category]
    @Binding var selectedIcon: String
    var accentColorHex: String

    @State private var expandedCategories: Set<String> = []

    private let columns = Array(repeating: GridItem(.flexible()), count: 6)

    var body: some View {
        ForEach(categories) { category in
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        if expandedCategories.contains(category.id) {
                            expandedCategories.remove(category.id)
                        } else {
                            expandedCategories.insert(category.id)
                        }
                    }
                } label: {
                    HStack {
                        Text(category.name)
                            .foregroundStyle(.primary)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expandedCategories.contains(category.id) ? 90 : 0))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if expandedCategories.contains(category.id) {
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(category.icons, id: \.self) { icon in
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
                        }
                    }
                    .padding(.top, 8)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

struct ColorPicker: View {
    let colors: [String]
    @Binding var selectedColor: String

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 5), spacing: 12) {
            ForEach(colors, id: \.self) { hex in
                Circle()
                    .fill(Color(hex: hex) ?? .gray)
                    .frame(width: 36, height: 36)
                    .overlay {
                        if selectedColor == hex {
                            Image(systemName: "checkmark")
                                .font(.caption.bold())
                                .foregroundStyle(.white)
                        }
                    }
                    .onTapGesture { selectedColor = hex }
            }
        }
        .padding(.vertical, 4)
    }
}
