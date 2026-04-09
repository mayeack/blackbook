import Foundation
import SwiftData

/// A recorded interaction (call, meeting, text, etc.) between the user and a contact.
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

    /// Raw storage for message direction (sent/received). Nil for manually logged interactions.
    var directionRaw: String?

    /// Typed accessor for message direction.
    var messageDirection: MessageDirection? {
        get { directionRaw.flatMap(MessageDirection.init(rawValue:)) }
        set { directionRaw = newValue?.rawValue }
    }

    var updatedAt: Date = Date()
    var syncStatus: String = SyncStatus.pending.rawValue
    var lastSyncedAt: Date?

    /// Creates a new interaction linked to the given contact.
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
        self.updatedAt = Date()
    }
}

/// The channel through which an interaction occurred.
enum InteractionType: String, Codable, CaseIterable, Identifiable {
    case call = "Call"
    case meeting = "Meeting"
    case text = "Text"
    case email = "Email"
    case social = "Social"
    case other = "Other"

    var id: String { rawValue }

    /// SF Symbol name representing this interaction type.
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

/// Direction of an auto-synced message (e.g. iMessage).
enum MessageDirection: String, Codable, CaseIterable, Identifiable {
    case sent = "Sent"
    case received = "Received"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .sent: return "arrow.up.circle.fill"
        case .received: return "arrow.down.circle.fill"
        }
    }
}

/// Emotional tone of an interaction, used to influence relationship score calculations.
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

    /// Numeric weight for score calculations: positive=1.0, neutral=0.5, negative=0.0.
    var weight: Double {
        switch self {
        case .positive: return 1.0
        case .neutral: return 0.5
        case .negative: return 0.0
        }
    }
}
