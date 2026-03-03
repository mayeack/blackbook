import Foundation
import SwiftData

@Model
final class Interaction {
    var id: UUID
    var contact: Contact?
    var type: InteractionType
    var date: Date
    var duration: TimeInterval?
    var summary: String?
    var sentiment: Sentiment?
    var createdAt: Date

    init(
        contact: Contact,
        type: InteractionType,
        date: Date = Date(),
        duration: TimeInterval? = nil,
        summary: String? = nil,
        sentiment: Sentiment? = nil
    ) {
        self.id = UUID()
        self.contact = contact
        self.type = type
        self.date = date
        self.duration = duration
        self.summary = summary
        self.sentiment = sentiment
        self.createdAt = Date()
    }
}

enum InteractionType: String, Codable, CaseIterable, Identifiable {
    case call = "Call"
    case meeting = "Meeting"
    case text = "Text"
    case email = "Email"
    case social = "Social"
    case other = "Other"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .call: return "phone.fill"
        case .meeting: return "person.2.fill"
        case .text: return "message.fill"
        case .email: return "envelope.fill"
        case .social: return "globe"
        case .other: return "ellipsis.circle.fill"
        }
    }
}

enum Sentiment: String, Codable, CaseIterable, Identifiable {
    case positive = "Positive"
    case neutral = "Neutral"
    case negative = "Negative"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .positive: return "face.smiling"
        case .neutral: return "face.smiling.inverse"
        case .negative: return "cloud.rain"
        }
    }

    var weight: Double {
        switch self {
        case .positive: return 1.0
        case .neutral: return 0.5
        case .negative: return 0.0
        }
    }
}
