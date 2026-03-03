import Foundation
import SwiftData
import SwiftUI

@Model
final class Tag {
    var id: UUID
    var name: String
    var colorHex: String
    var contacts: [Contact]

    var color: Color {
        Color(hex: colorHex) ?? .accentColor
    }

    init(name: String, colorHex: String = "D4A017") {
        self.id = UUID()
        self.name = name
        self.colorHex = colorHex
        self.contacts = []
    }
}

extension Color {
    init?(hex: String) {
        let sanitized = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard sanitized.count == 6,
              let int = UInt64(sanitized, radix: 16) else { return nil }
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }

    var hexString: String {
        guard let components = cgColor?.components, components.count >= 3 else { return "D4A017" }
        let r = Int(components[0] * 255)
        let g = Int(components[1] * 255)
        let b = Int(components[2] * 255)
        return String(format: "%02X%02X%02X", r, g, b)
    }
}
