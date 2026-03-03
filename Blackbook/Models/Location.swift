import Foundation
import SwiftData
import SwiftUI

@Model
final class Location {
    var id: UUID
    var name: String
    var colorHex: String
    var icon: String
    var contacts: [Contact]

    var color: Color {
        Color(hex: colorHex) ?? .accentColor
    }

    init(name: String, colorHex: String = "3498DB", icon: String = "mappin") {
        self.id = UUID()
        self.name = name
        self.colorHex = colorHex
        self.icon = icon
        self.contacts = []
    }
}
