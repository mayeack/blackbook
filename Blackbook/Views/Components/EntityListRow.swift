import SwiftUI

/// Standard row layout for data lists (Activities, Suggested Activities, future
/// Contact / Group / Tag / Location lists). 36×36 gradient icon, medium-weight
/// title, secondary caption subtitle. Use the `trailing` slot for accessories
/// such as counts, chevrons, badges. Settings rows use the smaller `SettingsRow`.
struct EntityListRow<Trailing: View>: View {
    let icon: String
    let iconColor: Color
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(iconColor.gradient, in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            trailing()
        }
        .padding(.vertical, 2)
    }
}

extension EntityListRow where Trailing == EmptyView {
    init(icon: String, iconColor: Color, title: String, subtitle: String? = nil) {
        self.init(icon: icon, iconColor: iconColor, title: title, subtitle: subtitle, trailing: { EmptyView() })
    }
}
